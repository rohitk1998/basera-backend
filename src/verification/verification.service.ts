import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity, VerificationAuditLogEntity, VerificationRequestEntity } from '../entities';
import { StorageService } from '../storage/storage.service';
import { namesMatch } from './names-match';
import { MyVerificationStatus, NotStartedStatus, VerificationRowStatus } from './verification.types';

const VERIFICATION_DOCUMENTS_BUCKET = 'verification-documents';
const DOCUMENT_URL_EXPIRES_IN_SECONDS = 300;

const DIDIT_SUBTYPE = 'didit';
const DIDIT_GENERIC_REJECTION = 'Your verification could not be completed. Please try again.';
const DIDIT_NAME_MISMATCH = 'The name on your ID does not match the name on your profile.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_STARTED: NotStartedStatus = {
  status: 'not_started',
  documentSubtype: null,
  rejectionReason: null,
  submittedAt: null,
  reviewedAt: null,
  hasBackDocument: false,
};

@Injectable()
export class VerificationService {
  constructor(
    @InjectRepository(VerificationRequestEntity)
    private readonly requests: Repository<VerificationRequestEntity>,
    @InjectRepository(VerificationAuditLogEntity)
    private readonly auditLog: Repository<VerificationAuditLogEntity>,
    @InjectRepository(UserEntity)
    private readonly profiles: Repository<UserEntity>,
    private readonly storage: StorageService,
  ) {}

  async getMyStatus(userId: string): Promise<MyVerificationStatus> {
    const [identity, selfie] = await Promise.all([
      this.mostRecent(userId, 'identity'),
      this.mostRecent(userId, 'selfie'),
    ]);

    return {
      identity: identity ? this.toVerificationRowStatus(identity) : NOT_STARTED,
      selfie: selfie ? this.toVerificationRowStatus(selfie) : NOT_STARTED,
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

  private toVerificationRowStatus(row: VerificationRequestEntity): VerificationRowStatus {
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

  async assertCanStartDiditSession(userId: string): Promise<void> {
    const [identity, selfie] = await Promise.all([this.mostRecent(userId, 'identity'), this.mostRecent(userId, 'selfie')]);
    if (identity?.status === 'verified' && selfie?.status === 'verified') {
      throw new ConflictException('Your identity and selfie are already verified.');
    }
  }

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

  private async writeAudit(
    verificationRequestId: string,
    userId: string,
    action: 'submitted' | 'approved' | 'rejected',
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
