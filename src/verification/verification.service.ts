import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  HttpException,
  ServiceUnavailableException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Not, Raw, Repository } from 'typeorm';
import { UserEntity, VerificationAuditLogEntity, VerificationRequestEntity } from '../entities';
import { StorageService, VerificationDocumentFile } from '../storage/storage.service';
import { AadhaarOcrOutcome, CashfreeService, VerificationOutcome } from '../payments/cashfree.service';
import { AadhaarDecision, AadhaarSummary, evaluateAadhaar, namesMatch } from './aadhaar-evaluation';
import { DocumentAnalysisService } from './document-analysis.service';
import {
  BankStatus,
  IdentityOrPanStatus,
  MyVerificationStatus,
  NotStartedStatus,
} from './verification.types';

const VERIFICATION_DOCUMENTS_BUCKET = 'verification-documents';
const DOCUMENT_URL_EXPIRES_IN_SECONDS = 300;

// Every automated check is a billed Cashfree call — cap failed attempts per
// verification type so a user can't burn quota by retrying guesses.
const MAX_FAILED_AUTO_ATTEMPTS_PER_DAY = 5;

// Rejection reason written when a newer automated attempt replaces an older
// one. Those rows are bookkeeping, not failures, so they don't count toward
// the daily cap.
const SUPERSEDED_AUTO_REASON = 'Replaced by an automated verification.';

const DIDIT_SUBTYPE = 'didit';
const DIDIT_GENERIC_REJECTION = 'Your verification could not be completed. Please try again.';
const DIDIT_NAME_MISMATCH = 'The name on your ID does not match the name on your profile.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IdentityDocumentSubtype = 'aadhaar';

// Smart OCR accepts JPEG, PNG and PDF up to 5 MB — anything else would be
// refused by Cashfree after we had already paid the round trip.
const AADHAAR_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const AADHAAR_MAX_BYTES = 5 * 1024 * 1024;

export interface BankDetailsInput {
  accountHolderName: string;
  bankName: string;
  accountNumber: string;
  ifsc: string;
}

const NOT_STARTED: NotStartedStatus = {
  status: 'not_started',
  documentSubtype: null,
  rejectionReason: null,
  submittedAt: null,
  reviewedAt: null,
  hasBackDocument: false,
};

/**
 * State machine for the user-facing verification lifecycle
 * (identity / pan / bank / selfie). A row only exists once a user has submitted
 * something — "not_started" is the absence of any row for a given
 * (user_id, verification_type). The most recent row is always the current
 * status; resubmission inserts a NEW row rather than mutating the old one,
 * preserving history (see migrations/20260913_verification_requests.sql).
 *
 * Nothing here ever writes status/reviewed_by/reviewed_at/analysis_result
 * from caller input — status is always 'pending' on insert, and
 * reviewed_by/reviewed_at/analysis_result review fields are only ever set
 * by the (future) admin review flow.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    @InjectRepository(VerificationRequestEntity)
    private readonly requests: Repository<VerificationRequestEntity>,
    @InjectRepository(VerificationAuditLogEntity)
    private readonly auditLog: Repository<VerificationAuditLogEntity>,
    @InjectRepository(UserEntity)
    private readonly profiles: Repository<UserEntity>,
    private readonly storage: StorageService,
    private readonly documentAnalysis: DocumentAnalysisService,
    private readonly cashfree: CashfreeService,
    private readonly config: ConfigService,
  ) {}

  private aadhaarMode(): 'admin' | 'cashfree' {
    return this.config.get<string>('AADHAAR_VERIFICATION_MODE') === 'cashfree' ? 'cashfree' : 'admin';
  }

  /** Aadhaar goes to the admin review queue unless Cashfree Smart OCR is switched on. */
  private isAadhaarAdminReview(): boolean {
    return this.aadhaarMode() === 'admin';
  }

  // ── Status ────────────────────────────────────────────────────────────

  async getMyStatus(userId: string): Promise<MyVerificationStatus> {
    const [identity, pan, bank, selfie, profile] = await Promise.all([
      this.mostRecent(userId, 'identity'),
      this.mostRecent(userId, 'pan'),
      this.mostRecent(userId, 'bank'),
      this.mostRecent(userId, 'selfie'),
      this.profiles.findOne({ where: { id: userId }, select: { id: true, bank_upi: true } }),
    ]);

    return {
      identity: identity ? this.toIdentityOrPanStatus(identity) : NOT_STARTED,
      pan: pan ? this.toIdentityOrPanStatus(pan) : NOT_STARTED,
      bank: bank ? this.toBankStatus(bank) : NOT_STARTED,
      selfie: selfie ? this.toIdentityOrPanStatus(selfie) : NOT_STARTED,
      upiId: profile?.bank_upi ?? null,
      kycProvider: this.kycProvider(),
    };
  }

  private kycProvider(): 'didit' | 'admin' {
    return this.config.get<string>('KYC_PROVIDER') === 'didit' ? 'didit' : 'admin';
  }

  isDiditEnabled(): boolean {
    return this.kycProvider() === 'didit';
  }

  private async mostRecent(
    userId: string,
    verificationType: string,
  ): Promise<VerificationRequestEntity | null> {
    return this.requests.findOne({
      where: { user_id: userId, verification_type: verificationType },
      order: { submitted_at: 'DESC' },
    });
  }

  private toIdentityOrPanStatus(row: VerificationRequestEntity): IdentityOrPanStatus {
    return {
      id: row.id,
      status: row.status as 'pending' | 'verified' | 'rejected',
      documentSubtype: row.document_subtype,
      rejectionReason: row.rejection_reason,
      submittedAt: row.submitted_at.toISOString(),
      reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
      hasBackDocument: row.document_path_back != null,
    };
  }

  private toBankStatus(row: VerificationRequestEntity): BankStatus {
    return {
      ...this.toIdentityOrPanStatus(row),
      bankAccountHolderName: row.bank_account_holder_name,
      bankName: row.bank_name,
      bankAccountNumber: row.bank_account_number,
      bankIfsc: row.bank_ifsc,
    };
  }

  // ── Transition rule ──────────────────────────────────────────────────

  /**
   * Allowed to submit when no row exists yet for this type, OR the most
   * recent row is 'rejected'. Never when pending or verified. `isResubmit`
   * narrows this further: a resubmission is only allowed when a most
   * recent row exists AND is rejected (there is nothing to "resubmit" if
   * nothing was ever submitted).
   */
  private async assertCanSubmit(
    userId: string,
    verificationType: string,
    isResubmit: boolean,
  ): Promise<VerificationRequestEntity | null> {
    const latest = await this.mostRecent(userId, verificationType);

    if (isResubmit) {
      if (!latest) {
        throw new ConflictException(
          `No previous ${verificationType} submission found to resubmit. Use the initial submission instead.`,
        );
      }
      if (latest.status !== 'rejected') {
        throw new ConflictException(
          `Your ${verificationType} verification is already ${latest.status}. It cannot be resubmitted right now.`,
        );
      }
      return latest;
    }

    if (latest && latest.status !== 'rejected') {
      throw new ConflictException(
        `Your ${verificationType} verification is already ${latest.status}. Wait for review before submitting again.`,
      );
    }

    return latest;
  }

  /**
   * Saves a newly-created 'pending' row, translating the partial unique
   * index on (user_id, verification_type) WHERE status = 'pending' (see
   * migrations/20260913_verification_requests_pending_unique.sql) into the
   * same 409 assertCanSubmit already throws for the non-racing case. That
   * index is what actually closes the race assertCanSubmit alone cannot:
   * two concurrent submissions can both read "no pending row yet" before
   * either has inserted, but only one of the resulting inserts can win.
   */
  private async saveNewRequest(
    row: VerificationRequestEntity,
    verificationType: string,
  ): Promise<VerificationRequestEntity> {
    try {
      return await this.requests.save(row);
    } catch (err: any) {
      if (err?.code === '23505') {
        throw new ConflictException(
          `Your ${verificationType} verification is already pending. Wait for review before submitting again.`,
        );
      }
      throw err;
    }
  }

  // ── Identity (Aadhaar document, reviewed by an admin) ─────────────────

  async submitIdentity(
    userId: string,
    documentSubtype: IdentityDocumentSubtype,
    file: VerificationDocumentFile,
    fileBack: VerificationDocumentFile,
  ): Promise<IdentityOrPanStatus> {
    return this.submitIdentityInternal(userId, documentSubtype, file, fileBack, false);
  }

  async resubmitIdentity(
    userId: string,
    documentSubtype: IdentityDocumentSubtype,
    file: VerificationDocumentFile,
    fileBack: VerificationDocumentFile,
  ): Promise<IdentityOrPanStatus> {
    return this.submitIdentityInternal(userId, documentSubtype, file, fileBack, true);
  }

  private assertAadhaarFile(file: VerificationDocumentFile, label: string): void {
    if (!AADHAAR_ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(`The ${label} of your Aadhaar must be a JPEG, PNG or PDF file.`);
    }
    if (file.size > AADHAAR_MAX_BYTES) {
      throw new PayloadTooLargeException(`The ${label} of your Aadhaar is too large. Maximum size is 5 MB.`);
    }
  }

  /**
   * Admin mode (default): both sides are stored and a 'pending' row waits in
   * the admin review queue — no third-party call is made.
   *
   * Cashfree mode (AADHAAR_VERIFICATION_MODE=cashfree): both sides are read by
   * Cashfree Smart OCR and judged by evaluateAadhaar: a clean, UIDAI-signed
   * card whose name matches the profile is verified on the spot; anything else
   * is refused with a reason the user can act on. There is no manual review.
   * If Cashfree itself cannot answer (outage, low balance, auth, account not
   * enabled) the user gets a "try again later" error and NOTHING is stored or
   * counted against their daily attempts — the check is decided before the
   * files are uploaded for exactly that reason.
   */
  private async submitIdentityInternal(
    userId: string,
    documentSubtype: IdentityDocumentSubtype,
    file: VerificationDocumentFile,
    fileBack: VerificationDocumentFile,
    isResubmit: boolean,
  ): Promise<IdentityOrPanStatus> {
    if (!file) {
      throw new BadRequestException('No file provided.');
    }
    // The controller already rejects a missing back side (400) before this is
    // called — this is defense in depth for any other caller of the service.
    if (!fileBack) {
      throw new BadRequestException('Both sides of your Aadhaar card are required.');
    }
    this.assertAadhaarFile(file, 'front');
    this.assertAadhaarFile(fileBack, 'back');

    await this.assertCanSubmit(userId, 'identity', isResubmit);

    if (this.isAadhaarAdminReview()) {
      return this.queueAadhaarForReview(userId, documentSubtype, file, fileBack, isResubmit);
    }

    await this.assertUnderAttemptCap(userId, 'identity');
    const profileName = await this.requireProfileName(userId);

    // Throws a 503 when Cashfree cannot answer — before anything is stored.
    const decision = await this.decideAadhaar(file, fileBack, profileName);

    // Stored so the file is on record whatever the outcome (this also
    // validates the real file signature).
    const { path } = await this.storage.uploadVerificationDocument(userId, 'identity', file);
    const uploadedBack = await this.storage.uploadVerificationDocument(userId, 'identity-back', fileBack);

    const verified = decision.decision === 'verified';
    const row = this.requests.create({
      user_id: userId,
      verification_type: 'identity',
      document_subtype: documentSubtype,
      status: verified ? 'verified' : 'rejected',
      document_path: path,
      document_path_back: uploadedBack.path,
      rejection_reason: verified ? null : decision.reason!,
      reviewed_at: new Date(),
      analysis_result: decision.analysis,
    });
    const saved = await this.saveNewRequest(row, 'identity');

    await this.writeAudit(saved.id, userId, isResubmit ? 'resubmitted' : 'submitted', null, saved.status);

    return this.toIdentityOrPanStatus(saved);
  }

  private async queueAadhaarForReview(
    userId: string,
    documentSubtype: IdentityDocumentSubtype,
    file: VerificationDocumentFile,
    fileBack: VerificationDocumentFile,
    isResubmit: boolean,
  ): Promise<IdentityOrPanStatus> {
    const front = await this.storage.uploadVerificationDocument(userId, 'identity', file);
    const back = await this.storage.uploadVerificationDocument(userId, 'identity-back', fileBack);
    const [frontAnalysis, backAnalysis] = await Promise.all([
      this.analyzeDocument(file, 'identity', documentSubtype),
      this.analyzeDocument(fileBack, 'identity', documentSubtype),
    ]);

    const row = this.requests.create({
      user_id: userId,
      verification_type: 'identity',
      document_subtype: documentSubtype,
      status: 'pending',
      document_path: front.path,
      document_path_back: back.path,
      analysis_result: { front: frontAnalysis, back: backAnalysis } as unknown as Record<string, unknown>,
    });
    const saved = await this.saveNewRequest(row, 'identity');

    await this.writeAudit(saved.id, userId, isResubmit ? 'resubmitted' : 'submitted', null, 'pending');

    return this.toIdentityOrPanStatus(saved);
  }

  private async decideAadhaar(
    file: VerificationDocumentFile,
    fileBack: VerificationDocumentFile,
    profileName: string,
  ): Promise<{ decision: AadhaarDecision['decision']; reason?: string; analysis: Record<string, unknown> }> {
    // A ServiceUnavailableException from Cashfree propagates as-is: a 503 the user can retry.
    const outcomes = await Promise.all([
      this.cashfree.readAadhaarImage({ image: file.buffer, mimetype: file.mimetype }),
      this.cashfree.readAadhaarImage({ image: fileBack.buffer, mimetype: fileBack.mimetype }),
    ]);

    const refused = outcomes.find((o) => !o.ok);
    if (refused && !refused.ok) {
      return { decision: 'rejected', reason: refused.reason, analysis: { source: 'cashfree-smart-ocr', flags: ['file-refused'] } };
    }
    const [a, b] = outcomes as [Extract<AadhaarOcrOutcome, { ok: true }>, Extract<AadhaarOcrOutcome, { ok: true }>];
    const evaluated = evaluateAadhaar(a.result, b.result, profileName);
    return {
      decision: evaluated.decision,
      reason: evaluated.decision === 'verified' ? undefined : evaluated.reason,
      analysis: evaluated.summary as AadhaarSummary as unknown as Record<string, unknown>,
    };
  }

  // ── PAN ──────────────────────────────────────────────────────────────

  async submitPan(userId: string, file: VerificationDocumentFile): Promise<IdentityOrPanStatus> {
    return this.submitPanInternal(userId, file, false);
  }

  async resubmitPan(userId: string, file: VerificationDocumentFile): Promise<IdentityOrPanStatus> {
    return this.submitPanInternal(userId, file, true);
  }

  private async submitPanInternal(
    userId: string,
    file: VerificationDocumentFile,
    isResubmit: boolean,
  ): Promise<IdentityOrPanStatus> {
    if (!file) {
      throw new BadRequestException('No file provided.');
    }

    await this.assertCanSubmit(userId, 'pan', isResubmit);

    const { path } = await this.storage.uploadVerificationDocument(userId, 'pan', file);
    const analysis = await this.analyzeDocument(file, 'pan');

    const row = this.requests.create({
      user_id: userId,
      verification_type: 'pan',
      document_subtype: null,
      status: 'pending',
      document_path: path,
      analysis_result: analysis as unknown as Record<string, unknown>,
    });
    const saved = await this.saveNewRequest(row, 'pan');

    await this.writeAudit(saved.id, userId, isResubmit ? 'resubmitted' : 'submitted', null, 'pending');

    return this.toIdentityOrPanStatus(saved);
  }

  // ── Bank ─────────────────────────────────────────────────────────────

  async submitBank(
    userId: string,
    bankDetails: BankDetailsInput,
    file?: VerificationDocumentFile,
  ): Promise<BankStatus> {
    return this.submitBankInternal(userId, bankDetails, file, false);
  }

  async resubmitBank(
    userId: string,
    bankDetails: BankDetailsInput,
    file?: VerificationDocumentFile,
  ): Promise<BankStatus> {
    return this.submitBankInternal(userId, bankDetails, file, true);
  }

  /**
   * Bank is the one verification type where "verified" isn't final — a host
   * may need to point payouts at a different account later (closed account,
   * switched banks). Every other type (identity/pan/selfie) stays locked
   * once verified, by design: there's no equivalent "I need to change this"
   * case for a selfie or a PAN card. Submitting a change re-runs the ₹1
   * check via a fresh 'pending' row, same as any other submission — it does
   * not silently keep paying out to the old account while under review.
   */
  async changeBank(
    userId: string,
    bankDetails: BankDetailsInput,
    file?: VerificationDocumentFile,
  ): Promise<BankStatus> {
    const latest = await this.mostRecent(userId, 'bank');
    if (!latest || latest.status !== 'verified') {
      throw new ConflictException('No verified bank account to change. Use the initial submission instead.');
    }
    const result = await this.submitBankInternal(userId, bankDetails, file, false, /* allowFromVerified */ true);

    // The new details are 'pending' review, not yet actually confirmed — the
    // account-level gate (assertVerified, isFullyVerified) must not still
    // treat this host as verified off the OLD account's now-superseded
    // approval timestamp while the new one is under review.
    await this.profiles.update({ id: userId }, { bank_verified_at: null });

    return result;
  }

  private async submitBankInternal(
    userId: string,
    bankDetails: BankDetailsInput,
    file: VerificationDocumentFile | undefined,
    isResubmit: boolean,
    allowFromVerified = false,
  ): Promise<BankStatus> {
    this.assertValidBankDetails(bankDetails);

    if (allowFromVerified) {
      // changeBank already confirmed the latest row is 'verified' — skip the
      // shared assertCanSubmit gate entirely rather than loosen it for every
      // verification type.
    } else {
      await this.assertCanSubmit(userId, 'bank', isResubmit);
    }

    // A supporting document (e.g. cancelled cheque / passbook) is optional
    // for bank verification — the row may carry only account details, per
    // document_path being nullable for verification_type = 'bank'.
    let path: string | null = null;
    let analysis: Record<string, unknown> | null = null;
    if (file) {
      const uploaded = await this.storage.uploadVerificationDocument(userId, 'bank', file);
      path = uploaded.path;
      analysis = (await this.analyzeDocument(file, 'bank')) as unknown as Record<string, unknown>;
    }

    const row = this.requests.create({
      user_id: userId,
      verification_type: 'bank',
      document_subtype: null,
      status: 'pending',
      document_path: path,
      bank_account_holder_name: bankDetails.accountHolderName,
      bank_name: bankDetails.bankName,
      bank_account_number: bankDetails.accountNumber,
      bank_ifsc: bankDetails.ifsc.toUpperCase(),
      analysis_result: analysis,
    });
    const saved = await this.saveNewRequest(row, 'bank');

    const auditAction = allowFromVerified ? 'changed' : isResubmit ? 'resubmitted' : 'submitted';
    await this.writeAudit(saved.id, userId, auditAction, null, 'pending');

    return this.toBankStatus(saved);
  }

  private assertValidBankDetails(bankDetails: BankDetailsInput): void {
    if (!bankDetails) {
      throw new BadRequestException('Bank details are required.');
    }
    const { accountHolderName, bankName, accountNumber, ifsc } = bankDetails;

    if (!accountHolderName || accountHolderName.trim().length < 3) {
      throw new BadRequestException('Enter the account holder name exactly as your bank has it.');
    }
    if (!bankName || bankName.trim().length < 2) {
      throw new BadRequestException('Enter your bank name.');
    }
    if (!accountNumber || !/^\d{6,20}$/.test(accountNumber)) {
      throw new BadRequestException('Enter a valid account number.');
    }
    if (!ifsc || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc.toUpperCase())) {
      throw new BadRequestException('Enter a valid 11-character IFSC code.');
    }
  }

  // ── Selfie ───────────────────────────────────────────────────────────

  async submitSelfie(userId: string, file: VerificationDocumentFile): Promise<IdentityOrPanStatus> {
    return this.submitSelfieInternal(userId, file, false);
  }

  async resubmitSelfie(userId: string, file: VerificationDocumentFile): Promise<IdentityOrPanStatus> {
    return this.submitSelfieInternal(userId, file, true);
  }

  private async submitSelfieInternal(
    userId: string,
    file: VerificationDocumentFile,
    isResubmit: boolean,
  ): Promise<IdentityOrPanStatus> {
    if (!file) {
      throw new BadRequestException('No file provided.');
    }

    await this.assertCanSubmit(userId, 'selfie', isResubmit);

    const { path } = await this.storage.uploadVerificationDocument(userId, 'selfie', file);
    const analysis = await this.analyzeDocument(file, 'selfie');

    const row = this.requests.create({
      user_id: userId,
      verification_type: 'selfie',
      document_subtype: null,
      status: 'pending',
      document_path: path,
      analysis_result: analysis as unknown as Record<string, unknown>,
    });
    const saved = await this.saveNewRequest(row, 'selfie');

    await this.writeAudit(saved.id, userId, isResubmit ? 'resubmitted' : 'submitted', null, 'pending');

    return this.toIdentityOrPanStatus(saved);
  }

  // ── Didit hosted workflow (KYC_PROVIDER=didit) ───────────────────────

  /** A session is pointless once both identity and selfie are verified. */
  async assertCanStartDiditSession(userId: string): Promise<void> {
    const [identity, selfie] = await Promise.all([this.mostRecent(userId, 'identity'), this.mostRecent(userId, 'selfie')]);
    if (identity?.status === 'verified' && selfie?.status === 'verified') {
      throw new ConflictException('Your identity and selfie are already verified.');
    }
  }

  /** Friendly, fixed sentence from Didit's warning risk tags — never raw provider text. */
  private diditRejectionReason(decision: any): string {
    const tags: string[] = [];
    for (const list of ['id_verifications', 'liveness_checks', 'face_matches']) {
      const first = Array.isArray(decision?.[list]) ? decision[list][0] : null;
      for (const w of Array.isArray(first?.warnings) ? first.warnings : []) {
        if (typeof w?.risk === 'string') tags.push(w.risk.toUpperCase());
      }
    }
    const has = (...needles: string[]) => tags.some((t) => needles.some((n) => t.includes(n)));
    if (has('EXPIRED')) return 'This ID has expired.';
    if (has('SCREEN', 'PRINT', 'PHOTOCOPY', 'PHOTO_OF')) return 'Please use your physical card, not a screenshot or a photocopy.';
    if (has('FACE_MATCH', 'SIMILARITY', 'MISMATCH')) return 'Your selfie did not match the photo on your ID.';
    if (has('LIVENESS', 'SPOOF', 'FACE')) return 'We could not confirm a live selfie. Please try again in good light.';
    return DIDIT_GENERIC_REJECTION;
  }

  /**
   * Applies a signature-verified Didit status.updated event. Identity and selfie
   * are written together because one hosted workflow covers both. A verified row
   * is final; an older or status-unchanging event is a no-op. Unknown users and
   * unknown statuses are ignored (the webhook still answers 200).
   */
  async applyDiditWebhook(payload: Record<string, any>): Promise<void> {
    const userId = typeof payload.vendor_data === 'string' ? payload.vendor_data : '';
    if (!UUID_RE.test(userId)) return;
    const profile = await this.profiles.findOne({ where: { id: userId }, select: { id: true, full_name: true } });
    if (!profile) return;

    const status = String(payload.status);
    let target: 'verified' | 'rejected' | 'pending';
    let reason: string | null = null;
    let nameMatched: boolean | undefined;
    if (status === 'Approved') {
      target = 'verified';
      const idv = payload.decision?.id_verifications?.[0];
      const fullName = typeof idv?.full_name === 'string' && idv.full_name.trim()
        ? idv.full_name
        : [idv?.first_name, idv?.last_name].filter((x) => typeof x === 'string' && x.trim()).join(' ');
      if (fullName.trim()) {
        nameMatched = namesMatch(profile.full_name ?? '', fullName);
        if (!nameMatched) {
          target = 'rejected';
          reason = DIDIT_NAME_MISMATCH;
        }
      }
    } else if (status === 'Declined') {
      target = 'rejected';
      reason = this.diditRejectionReason(payload.decision);
    } else if (status === 'In Review' || status === 'Resubmitted') {
      target = 'pending';
    } else {
      return;
    }

    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
    const ts = Number(payload.timestamp);
    const eventTimestamp = Number.isFinite(ts) ? ts : Math.floor(Date.now() / 1000);
    const analysis: Record<string, unknown> = {
      source: 'didit',
      provider: 'didit',
      sessionId,
      status,
      eventTimestamp,
      eventId: typeof payload.event_id === 'string' ? payload.event_id : null,
    };
    if (nameMatched !== undefined) analysis.nameMatched = nameMatched;

    let becameVerified = false;
    for (const type of ['identity', 'selfie']) {
      const latest = await this.mostRecent(userId, type);
      if (latest?.status === 'verified') continue;
      if (latest && latest.status === target) continue;
      const prev = latest?.analysis_result as Record<string, unknown> | null | undefined;
      if (prev?.source === 'didit' && prev.sessionId === sessionId && Number(prev.eventTimestamp) > eventTimestamp) continue;

      const now = new Date();
      const fields = {
        document_subtype: DIDIT_SUBTYPE,
        status: target,
        rejection_reason: target === 'rejected' ? reason : null,
        reviewed_at: target === 'pending' ? null : now,
        reviewed_by: null,
        analysis_result: analysis,
      };
      let rowId: string;
      if (latest?.status === 'pending') {
        await this.requests.update({ id: latest.id, status: 'pending' }, { ...fields, analysis_result: analysis as any, updated_at: now });
        rowId = latest.id;
      } else {
        const saved = await this.saveNewRequest(this.requests.create({ user_id: userId, verification_type: type, ...fields }), type);
        rowId = saved.id;
      }
      await this.writeAudit(
        rowId,
        userId,
        target === 'verified' ? 'approved' : target === 'rejected' ? 'rejected' : 'submitted',
        latest?.status ?? null,
        target,
        target === 'rejected' ? reason : null,
      );
      if (target === 'verified' && type === 'selfie') becameVerified = true;
    }
    if (becameVerified) {
      await this.profiles.update({ id: userId }, { selfie_uploaded_at: new Date() });
    }
  }

  // ── Automated checks (Cashfree Verification Suite) ──────────────────
  //
  // Unlike the document-upload flows above, these get an answer
  // immediately, so the row is written already 'verified' or 'rejected'
  // and the same profile columns the admin review sets on approval are set
  // here on success. An earlier still-'pending' upload for the same type is
  // superseded (rejected) so a later admin approval can't act on stale data.

  async verifyPanNumber(userId: string, pan: string, nameOverride?: string): Promise<IdentityOrPanStatus> {
    await this.assertCanAutoVerify(userId, 'pan');
    const name = nameOverride?.trim() || (await this.requireProfileName(userId));

    const outcome = await this.cashfree.verifyPan({ pan, name });
    const saved = await this.recordAutoResult(userId, 'pan', outcome, { panLast4: pan.slice(-4) });
    if (outcome.verified) {
      // Listings read the host's PAN from the profile, so the verified number lands there.
      await this.profiles.update({ id: userId }, { pan });
    }
    return this.toIdentityOrPanStatus(saved);
  }

  async verifyBankAccount(userId: string, bankDetails: BankDetailsInput): Promise<BankStatus> {
    // Bank name is optional here — Cashfree returns the real one.
    this.assertValidBankDetails({ ...bankDetails, bankName: bankDetails?.bankName || 'Bank' });
    await this.assertCanAutoVerify(userId, 'bank');

    const ifsc = bankDetails.ifsc.toUpperCase();
    const outcome = await this.cashfree.verifyBankAccount({
      accountNumber: bankDetails.accountNumber,
      ifsc,
      name: bankDetails.accountHolderName.trim(),
    });

    const saved = await this.recordAutoResult(
      userId,
      'bank',
      outcome,
      { nameAtBank: outcome.nameAtBank ?? null },
      {
        bank_account_holder_name: bankDetails.accountHolderName.trim(),
        bank_name: outcome.bankName ?? bankDetails.bankName?.trim() ?? null,
        bank_account_number: bankDetails.accountNumber,
        bank_ifsc: ifsc,
      },
    );

    if (outcome.verified) {
      await this.profiles.update(
        { id: userId },
        { bank_verified_at: new Date(), bank_account_name: bankDetails.accountHolderName.trim() },
      );
    }
    return this.toBankStatus(saved);
  }

  /**
   * UPI is not a verification_requests type — like the profile columns it
   * fills, it is either set (verified) or not. A failed check leaves any
   * previously verified UPI ID untouched.
   */
  async verifyUpiId(userId: string, vpa: string): Promise<{ vpa: string; nameAtBank: string | null }> {
    const name = await this.requireProfileName(userId);
    const outcome = await this.cashfree.verifyUpi({
      vpa,
      name,
      verificationId: `upi-${userId.replace(/-/g, '')}-${Date.now()}`,
    });
    if (!outcome.verified) {
      throw new BadRequestException(outcome.reason ?? 'This UPI ID could not be verified.');
    }
    await this.profiles.update({ id: userId }, { bank_upi: vpa.toLowerCase() });
    return { vpa: vpa.toLowerCase(), nameAtBank: outcome.nameAtBank ?? null };
  }

  async verifySelfieLiveness(userId: string, file: VerificationDocumentFile): Promise<IdentityOrPanStatus> {
    await this.assertCanAutoVerify(userId, 'selfie');
    if (!file?.buffer) {
      throw new BadRequestException('No file provided.');
    }
    if (file.mimetype !== 'image/jpeg' && file.mimetype !== 'image/png') {
      throw new BadRequestException('Use a JPEG or PNG photo for your selfie.');
    }

    // Stored first (this also validates size and the real file signature),
    // so an admin can look at the selfie later whatever the outcome.
    const { path } = await this.storage.uploadVerificationDocument(userId, 'selfie', file);
    const outcome = await this.cashfree.checkLiveness({
      image: file.buffer,
      mimetype: file.mimetype,
      verificationId: `selfie-${userId.replace(/-/g, '')}-${Date.now()}`,
    });

    const saved = await this.recordAutoResult(userId, 'selfie', outcome, {}, { document_path: path });
    if (outcome.verified) {
      await this.profiles.update({ id: userId }, { selfie_uploaded_at: new Date() });
    }
    return this.toIdentityOrPanStatus(saved);
  }

  private async requireProfileName(userId: string): Promise<string> {
    const profile = await this.profiles.findOne({ where: { id: userId }, select: { id: true, full_name: true } });
    const name = profile?.full_name?.trim();
    if (!name || name.length < 3) {
      throw new BadRequestException('Add your full name to your profile before verifying.');
    }
    return name;
  }

  /** Blocks an already-verified type (bank excepted — it can be changed) and over-eager retries. */
  private async assertCanAutoVerify(userId: string, verificationType: string): Promise<void> {
    const latest = await this.mostRecent(userId, verificationType);
    if (latest?.status === 'verified' && verificationType !== 'bank') {
      throw new ConflictException(`Your ${verificationType} is already verified.`);
    }

    await this.assertUnderAttemptCap(userId, verificationType);
  }

  private async assertUnderAttemptCap(userId: string, verificationType: string): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentFailures = await this.requests.count({
      where: {
        user_id: userId,
        verification_type: verificationType,
        status: 'rejected',
        reviewed_by: IsNull(),
        rejection_reason: Not(In([SUPERSEDED_AUTO_REASON])),
        // Didit declines are free and do not burn Cashfree quota. IS DISTINCT FROM keeps NULL subtypes counted.
        document_subtype: Raw((alias) => `${alias} IS DISTINCT FROM '${DIDIT_SUBTYPE}'`),
        submitted_at: MoreThan(since),
      },
    });
    if (recentFailures >= MAX_FAILED_AUTO_ATTEMPTS_PER_DAY) {
      throw new HttpException(
        `Too many failed ${verificationType} attempts today. Try again tomorrow or contact support.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async recordAutoResult(
    userId: string,
    verificationType: string,
    outcome: VerificationOutcome,
    summary: Record<string, unknown>,
    extra: Partial<VerificationRequestEntity> = {},
  ): Promise<VerificationRequestEntity> {
    const now = new Date();
    const status = outcome.verified ? 'verified' : 'rejected';

    // Supersede any earlier upload still waiting on an admin.
    await this.requests.update(
      { user_id: userId, verification_type: verificationType, status: 'pending' },
      {
        status: 'rejected',
        rejection_reason: SUPERSEDED_AUTO_REASON,
        updated_at: now,
      },
    );

    const row = this.requests.create({
      user_id: userId,
      verification_type: verificationType,
      document_subtype: null,
      status,
      rejection_reason: outcome.verified ? null : (outcome.reason ?? 'Verification failed.'),
      reviewed_at: now,
      analysis_result: {
        source: 'cashfree',
        referenceId: outcome.referenceId ?? null,
        nameMatchResult: outcome.nameMatchResult ?? null,
        ...summary,
      },
      ...extra,
    });
    const saved = await this.saveNewRequest(row, verificationType);
    await this.writeAudit(saved.id, userId, 'submitted', null, status);
    return saved;
  }

  // ── Document analysis helper ────────────────────────────────────────

  private async analyzeDocument(
    file: VerificationDocumentFile,
    verificationType: string,
    documentSubtype?: string,
  ) {
    try {
      return await this.documentAnalysis.analyze(file.buffer, file.mimetype, verificationType, documentSubtype);
    } catch (err) {
      this.logger.error('[VerificationService] document analysis failed', err as Error);
      return null;
    }
  }

  // ── Signed document URL ──────────────────────────────────────────────

  /**
   * A user may only request a signed URL for their OWN document. Admin
   * access to any document is a separate (future) admin-guarded route.
   */
  async getMyDocumentUrl(userId: string, verificationRequestId: string): Promise<{ url: string }> {
    const row = await this.requests.findOne({ where: { id: verificationRequestId } });
    if (!row) {
      throw new NotFoundException('Verification request not found.');
    }
    if (row.user_id !== userId) {
      throw new ForbiddenException('You do not have access to this document.');
    }
    if (!row.document_path) {
      throw new NotFoundException('No document was uploaded for this verification request.');
    }

    const url = await this.storage.createSignedDownloadUrl(
      VERIFICATION_DOCUMENTS_BUCKET,
      row.document_path,
      DOCUMENT_URL_EXPIRES_IN_SECONDS,
    );
    return { url };
  }

  // ── Audit log ────────────────────────────────────────────────────────

  private async writeAudit(
    verificationRequestId: string,
    userId: string,
    action: 'submitted' | 'resubmitted' | 'changed' | 'approved' | 'rejected',
    previousStatus: string | null,
    newStatus: string,
    reason: string | null = null,
  ): Promise<void> {
    const entry = this.auditLog.create({
      verification_request_id: verificationRequestId,
      user_id: userId,
      admin_id: null,
      action,
      previous_status: previousStatus,
      new_status: newStatus,
      rejection_reason: reason,
    });
    await this.auditLog.save(entry);
  }
}
