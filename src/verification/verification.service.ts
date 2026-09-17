import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VerificationAuditLogEntity, VerificationRequestEntity } from '../entities';
import { StorageService, VerificationDocumentFile } from '../storage/storage.service';
import { DocumentAnalysisService } from './document-analysis.service';
import {
  BankStatus,
  IdentityOrPanStatus,
  LegalStatus,
  MyVerificationStatus,
  NotStartedStatus,
} from './verification.types';

const VERIFICATION_DOCUMENTS_BUCKET = 'verification-documents';
const DOCUMENT_URL_EXPIRES_IN_SECONDS = 300;

export type IdentityDocumentSubtype = 'aadhaar' | 'passport' | 'driving_licence';

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
};

/**
 * State machine for the user-facing verification lifecycle
 * (identity / pan / bank / legal). A row only exists once a user has submitted
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
    private readonly storage: StorageService,
    private readonly documentAnalysis: DocumentAnalysisService,
  ) {}

  // ── Status ────────────────────────────────────────────────────────────

  async getMyStatus(userId: string): Promise<MyVerificationStatus> {
    const [identity, pan, bank, legal, selfie] = await Promise.all([
      this.mostRecent(userId, 'identity'),
      this.mostRecent(userId, 'pan'),
      this.mostRecent(userId, 'bank'),
      this.mostRecent(userId, 'legal'),
      this.mostRecent(userId, 'selfie'),
    ]);

    return {
      identity: identity ? this.toIdentityOrPanStatus(identity) : NOT_STARTED,
      pan: pan ? this.toIdentityOrPanStatus(pan) : NOT_STARTED,
      bank: bank ? this.toBankStatus(bank) : NOT_STARTED,
      legal: legal ? this.toLegalStatus(legal) : NOT_STARTED,
      selfie: selfie ? this.toIdentityOrPanStatus(selfie) : NOT_STARTED,
    };
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

  private toLegalStatus(row: VerificationRequestEntity): LegalStatus {
    return {
      ...this.toIdentityOrPanStatus(row),
      registrationNumber: row.registration_number,
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

  // ── Identity ─────────────────────────────────────────────────────────

  async submitIdentity(
    userId: string,
    documentSubtype: IdentityDocumentSubtype,
    file: VerificationDocumentFile,
  ): Promise<IdentityOrPanStatus> {
    return this.submitIdentityInternal(userId, documentSubtype, file, false);
  }

  async resubmitIdentity(
    userId: string,
    documentSubtype: IdentityDocumentSubtype,
    file: VerificationDocumentFile,
  ): Promise<IdentityOrPanStatus> {
    return this.submitIdentityInternal(userId, documentSubtype, file, true);
  }

  private async submitIdentityInternal(
    userId: string,
    documentSubtype: IdentityDocumentSubtype,
    file: VerificationDocumentFile,
    isResubmit: boolean,
  ): Promise<IdentityOrPanStatus> {
    if (!file) {
      throw new BadRequestException('No file provided.');
    }

    await this.assertCanSubmit(userId, 'identity', isResubmit);

    const { path } = await this.storage.uploadVerificationDocument(userId, 'identity', file);
    const analysis = await this.analyzeDocument(file, 'identity', documentSubtype);

    const row = this.requests.create({
      user_id: userId,
      verification_type: 'identity',
      document_subtype: documentSubtype,
      status: 'pending',
      document_path: path,
      analysis_result: analysis as unknown as Record<string, unknown>,
    });
    const saved = await this.saveNewRequest(row, 'identity');

    await this.writeAudit(saved.id, userId, isResubmit ? 'resubmitted' : 'submitted', null, 'pending');

    return this.toIdentityOrPanStatus(saved);
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

  private async submitBankInternal(
    userId: string,
    bankDetails: BankDetailsInput,
    file: VerificationDocumentFile | undefined,
    isResubmit: boolean,
  ): Promise<BankStatus> {
    this.assertValidBankDetails(bankDetails);

    await this.assertCanSubmit(userId, 'bank', isResubmit);

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

    await this.writeAudit(saved.id, userId, isResubmit ? 'resubmitted' : 'submitted', null, 'pending');

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

  // ── Legal (HP Tourism registration) ─────────────────────────────────

  async submitLegal(
    userId: string,
    registrationNumber: string,
    file: VerificationDocumentFile,
  ): Promise<LegalStatus> {
    return this.submitLegalInternal(userId, registrationNumber, file, false);
  }

  async resubmitLegal(
    userId: string,
    registrationNumber: string,
    file: VerificationDocumentFile,
  ): Promise<LegalStatus> {
    return this.submitLegalInternal(userId, registrationNumber, file, true);
  }

  private async submitLegalInternal(
    userId: string,
    registrationNumber: string,
    file: VerificationDocumentFile,
    isResubmit: boolean,
  ): Promise<LegalStatus> {
    this.assertValidRegistrationNumber(registrationNumber);
    if (!file) {
      throw new BadRequestException('No certificate file provided.');
    }

    await this.assertCanSubmit(userId, 'legal', isResubmit);

    const { path } = await this.storage.uploadVerificationDocument(userId, 'legal', file);
    const analysis = await this.analyzeDocument(file, 'legal');

    const row = this.requests.create({
      user_id: userId,
      verification_type: 'legal',
      document_subtype: null,
      status: 'pending',
      document_path: path,
      registration_number: registrationNumber.toUpperCase(),
      analysis_result: analysis as unknown as Record<string, unknown>,
    });
    const saved = await this.saveNewRequest(row, 'legal');

    await this.writeAudit(saved.id, userId, isResubmit ? 'resubmitted' : 'submitted', null, 'pending');

    return this.toLegalStatus(saved);
  }

  private assertValidRegistrationNumber(registrationNumber: string): void {
    if (!registrationNumber || !/^HP\/HS\/\d{3,5}\/\d{4}$/i.test(registrationNumber.trim())) {
      throw new BadRequestException('Enter a valid HP Tourism registration number, format HP/HS/1234/2025.');
    }
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
    action: 'submitted' | 'resubmitted',
    previousStatus: string | null,
    newStatus: string,
  ): Promise<void> {
    const entry = this.auditLog.create({
      verification_request_id: verificationRequestId,
      user_id: userId,
      admin_id: null,
      action,
      previous_status: previousStatus,
      new_status: newStatus,
      rejection_reason: null,
    });
    await this.auditLog.save(entry);
  }
}
