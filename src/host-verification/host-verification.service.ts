import { createHash } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, LessThan, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { HostVerificationCaseEntity, UserEntity, VerificationAuditEntity } from '../entities';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';
import { FaceMatchService } from './face-match.service';
import {
  ATTEMPT_WINDOW_DAYS,
  CONSENT_VERSION,
  FACE_MATCH_WARN_BELOW,
  FACE_MAX_AUTO_ATTEMPTS,
  FACE_STALE_MINUTES,
  HOST_SELFIE_BUCKET,
  HOST_VERIFICATION_BUCKET,
  ID_DOC_TYPES,
  LIVENESS_TOKEN_TTL_MS,
  MAX_IMAGE_BYTES,
  MAX_REJECTIONS_PER_WINDOW,
  MIN_HOST_AGE_YEARS,
  OPEN_CASE_DAYS_TO_START,
  REJECTION_COOLDOWN_MS,
  REQUIRED_CHALLENGES,
  REQUIRED_FRAMES,
  SLA_HOURS,
  SLA_WARN_HOURS,
  SUBMITTED_CASE_DAYS_TO_DECIDE,
  type IdDocType,
} from './host-verification.constants';
import {
  hashIdNumber,
  hashMaskedAadhaar,
  isPlausibleIdNumber,
  looksLikeAadhaarNumber,
  normalizeIdNumber,
  normalizeName,
} from './id-number.util';
import { reencodeToJpeg, sniffImage } from './image.util';
import { challengesFor, issueLivenessToken, newNonce, verifyLivenessToken } from './liveness-token.util';

export type UploadedImage = { buffer: Buffer; size: number };

export type SubmitInput = {
  docType: string;
  idNumber?: string;
  /** Last four digits printed on a masked Aadhaar. */
  aadhaarLast4?: string;
  /** Name exactly as printed on a masked Aadhaar (hashed together with the last four). */
  nameOnId?: string;
  livenessToken?: string;
  challenges: string[];
  document: UploadedImage | undefined;
  frames: UploadedImage[];
};

export type ApproveInput = {
  dateOfBirth: string;
  idExpiry?: string;
  adultConfirmed: boolean;
  notExpiredConfirmed?: boolean;
};

export type QueueParams = { status?: string; q?: string; page?: number; pageSize?: number };

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MEDIA_URL_SECONDS = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ['consented', 'submitted'] as const;

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; driverError?: { code?: string } } | null;
  return e?.code === '23505' || e?.driverError?.code === '23505';
};

/** Parses YYYY-MM-DD strictly (rejects 2020-02-31). */
function parseIsoDate(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
    ? d
    : null;
}

export function ageOn(dob: Date, today: Date): number {
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < dob.getUTCMonth() ||
    (today.getUTCMonth() === dob.getUTCMonth() && today.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

@Injectable()
export class HostVerificationService {
  private readonly logger = new Logger(HostVerificationService.name);

  constructor(
    @InjectRepository(HostVerificationCaseEntity)
    private readonly cases: Repository<HostVerificationCaseEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(VerificationAuditEntity) private readonly audits: Repository<VerificationAuditEntity>,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly faceMatch: FaceMatchService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------------ host side

  async getMyStatus(userId: string) {
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, is_id_verified: true, id_verified_at: true, banned_at: true },
    });
    const latest = await this.cases.findOne({ where: { user_id: userId }, order: { created_at: 'DESC' } });
    const cooldownUntil = await this.cooldownUntil(userId);
    const rejections = await this.recentRejections(userId);
    return {
      isIdVerified: Boolean(user?.is_id_verified),
      verifiedAt: user?.id_verified_at ?? null,
      banned: Boolean(user?.banned_at),
      cooldownUntil,
      attemptsRemaining: Math.max(0, MAX_REJECTIONS_PER_WINDOW - rejections),
      case: latest
        ? {
            id: latest.id,
            status: latest.status,
            rejectionReason: latest.status === 'rejected' ? latest.rejection_reason : null,
            submittedAt: latest.submitted_at,
            reviewedAt: latest.reviewed_at,
          }
        : null,
    };
  }

  /** Purpose-limitation consent comes first; nothing is captured before this row exists. */
  async startConsent(userId: string, version: string) {
    const pepper = this.requirePepper();
    if (version !== CONSENT_VERSION) {
      throw new BadRequestException('Please read and accept the latest notice.');
    }
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, is_id_verified: true, banned_at: true },
    });
    if (!user) throw new NotFoundException('Profile not found');
    if (user.banned_at) throw new ForbiddenException('We could not start verification for this account.');
    if (user.is_id_verified) throw new ConflictException('Your identity is already verified.');

    const open = await this.cases.findOne({ where: { user_id: userId, status: In([...OPEN_STATUSES]) } });
    if (open) return this.resumeOpenCase(open, userId, pepper);

    await this.assertCanStartNewAttempt(userId);

    const now = new Date();
    const nonce = newNonce();
    const expiresMs = now.getTime() + OPEN_CASE_DAYS_TO_START * DAY_MS;
    let caseId: string;
    try {
      const inserted = await this.cases.insert({
        user_id: userId,
        status: 'consented',
        consent_version: CONSENT_VERSION,
        consent_at: now,
        liveness_nonce: nonce,
        expires_at: new Date(expiresMs),
      });
      caseId = inserted.identifiers[0]?.id as string;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A concurrent request opened the case first: hand back that one.
      const winner = await this.cases.findOne({ where: { user_id: userId, status: In([...OPEN_STATUSES]) } });
      if (!winner) throw err;
      return this.resumeOpenCase(winner, userId, pepper);
    }
    await this.audit(caseId, userId, userId, 'consented', { version: CONSENT_VERSION });
    return this.consentResponse(caseId, userId, nonce, expiresMs, pepper);
  }

  private async resumeOpenCase(open: HostVerificationCaseEntity, userId: string, pepper: string) {
    if (open.status === 'submitted') {
      throw new ConflictException('Your verification is already with our team.');
    }
    const expiresMs = Date.now() + OPEN_CASE_DAYS_TO_START * DAY_MS;
    const nonce = open.liveness_nonce ?? newNonce();
    await this.cases.update({ id: open.id }, { expires_at: new Date(expiresMs), liveness_nonce: nonce });
    return this.consentResponse(open.id, userId, nonce, expiresMs, pepper);
  }

  private consentResponse(caseId: string, userId: string, nonce: string, caseExpiresMs: number, pepper: string) {
    const exp = Math.min(Date.now() + LIVENESS_TOKEN_TTL_MS, caseExpiresMs);
    return {
      success: true,
      caseId,
      liveness: {
        token: issueLivenessToken(caseId, userId, nonce, exp, pepper),
        challenges: challengesFor(nonce, pepper),
        expiresAt: new Date(exp).toISOString(),
      },
    };
  }

  private recentRejections(userId: string): Promise<number> {
    const since = new Date(Date.now() - ATTEMPT_WINDOW_DAYS * DAY_MS);
    return this.cases.count({ where: { user_id: userId, status: 'rejected', reviewed_at: MoreThanOrEqual(since) } });
  }

  private async cooldownUntil(userId: string): Promise<string | null> {
    const last = await this.cases.findOne({
      where: { user_id: userId, status: 'rejected' },
      order: { reviewed_at: 'DESC' },
      select: { id: true, reviewed_at: true },
    });
    if (!last?.reviewed_at) return null;
    const until = last.reviewed_at.getTime() + REJECTION_COOLDOWN_MS;
    return until > Date.now() ? new Date(until).toISOString() : null;
  }

  private async assertCanStartNewAttempt(userId: string): Promise<void> {
    if ((await this.recentRejections(userId)) >= MAX_REJECTIONS_PER_WINDOW) {
      throw new HttpException(
        'Too many unsuccessful attempts. Please contact support.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const until = await this.cooldownUntil(userId);
    if (until) {
      throw new HttpException(
        `Please wait before trying again. You can retry after ${until}.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async submit(userId: string, caseId: string, input: SubmitInput) {
    const pepper = this.requirePepper();

    const found = await this.cases.findOne({ where: { id: caseId, user_id: userId } });
    if (!found) throw new NotFoundException('Verification not found');
    if (found.status !== 'consented') throw new ConflictException('This verification was already submitted.');
    if (found.expires_at.getTime() < Date.now()) {
      throw new BadRequestException('This verification expired. Please start again.');
    }

    const docType = this.parseDocType(input.docType);

    const tokenState = verifyLivenessToken(input.livenessToken, caseId, userId, found.liveness_nonce, pepper);
    if (tokenState === 'expired') {
      throw new BadRequestException('The liveness check timed out. Please start the face check again.');
    }
    if (tokenState !== 'ok') {
      throw new BadRequestException('The liveness check was not completed.');
    }
    const challenges = this.parseChallenges(input.challenges, challengesFor(found.liveness_nonce!, pepper));

    const idHash = this.parseIdHash(docType, input, pepper);
    const { document, frames } = await this.parseImages(input);

    const banned = await this.users.findOne({
      where: { id_number_salted_hash: idHash, banned_at: Not(IsNull()) },
      select: { id: true },
    });
    if (banned) {
      await this.audit(caseId, userId, null, 'blocked_banned_id', {});
      throw new ForbiddenException('We could not verify this ID.');
    }
    const duplicateFlag = await this.isPotentialDuplicate(idHash, userId);

    const base = `${userId}/${caseId}`;
    const docPath = `${base}/id.jpg`;
    const framePaths = frames.map((_, i) => `${base}/frame-${i + 1}.jpg`);
    const uploaded: string[] = [];
    try {
      await this.storage.uploadPrivate(HOST_VERIFICATION_BUCKET, docPath, document.buffer, 'image/jpeg');
      uploaded.push(docPath);
      for (const [i, frame] of frames.entries()) {
        const path = framePaths[i]!;
        await this.storage.uploadPrivate(HOST_VERIFICATION_BUCKET, path, frame.buffer, 'image/jpeg');
        uploaded.push(path);
      }
    } catch (err) {
      await this.storage.remove(HOST_VERIFICATION_BUCKET, uploaded).catch(() => undefined);
      throw err;
    }

    const res = await this.cases.update(
      { id: caseId, status: 'consented' },
      {
        status: 'submitted',
        doc_type: docType,
        id_number_hash: idHash,
        doc_path: docPath,
        liveness_paths: framePaths,
        challenges,
        duplicate_flag: duplicateFlag,
        face_attempts: 1,
        submitted_at: new Date(),
        expires_at: new Date(Date.now() + SUBMITTED_CASE_DAYS_TO_DECIDE * DAY_MS),
        face_status: 'pending',
      },
    );
    if (!res.affected) {
      await this.storage.remove(HOST_VERIFICATION_BUCKET, uploaded).catch(() => undefined);
      throw new ConflictException('This verification was already submitted.');
    }
    await this.audit(caseId, userId, userId, 'submitted', {
      docType,
      challenges,
      duplicateFlag,
      // Ties the frames to this nonce in the audit trail (hash prefixes, not content).
      nonce: found.liveness_nonce,
      frameHashes: frames.map((f) => createHash('sha256').update(f.buffer).digest('hex').slice(0, 16)),
    });

    // Scored in the background from memory; the host is not kept waiting on the worker.
    void this.scoreBuffers(caseId, userId, document.buffer, frames.map((f) => f.buffer));

    return { success: true, status: 'submitted' as const };
  }

  // ------------------------------------------------------------------ admin side

  async listQueue(params: QueueParams) {
    const wanted =
      params.status && ['submitted', 'approved', 'rejected', 'expired'].includes(params.status)
        ? params.status
        : 'submitted';
    const pageSize = Math.min(50, Math.max(1, Math.floor(params.pageSize ?? 10)));
    const page = Math.max(1, Math.floor(params.page ?? 1));
    const term = params.q?.trim().slice(0, 100);
    const like = term ? `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;

    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT c.id, c.user_id, c.status, c.doc_type, c.face_score, c.face_status, c.challenges,
              c.submitted_at, c.reviewed_at, c.rejection_reason, c.purged_at, c.duplicate_flag,
              c.doc_expiry, u.full_name, u.phone, u.email,
              (SELECT count(*) FROM host_verification_cases x
                WHERE x.user_id = c.user_id AND x.submitted_at IS NOT NULL) AS attempts,
              count(*) OVER() AS total
         FROM host_verification_cases c
         JOIN users u ON u.id = c.user_id
        WHERE c.status = $1
          AND ($2::text IS NULL OR u.full_name ILIKE $2 OR u.email ILIKE $2)
        ORDER BY CASE WHEN c.status = 'submitted' THEN c.submitted_at END ASC NULLS LAST,
                 c.reviewed_at DESC NULLS LAST
        LIMIT $3 OFFSET $4`,
      [wanted, like, pageSize, (page - 1) * pageSize],
    );
    const now = Date.now();
    return {
      success: true,
      page,
      pageSize,
      total: rows.length ? Number(rows[0]!.total) : 0,
      slaHours: SLA_HOURS,
      items: rows.map((r) => {
        const submittedAt = r.submitted_at ? new Date(r.submitted_at as string) : null;
        const ageHours = submittedAt ? Math.max(0, (now - submittedAt.getTime()) / HOUR_MS) : null;
        return {
          id: r.id,
          userId: r.user_id,
          status: r.status,
          userName: r.full_name,
          phone: r.phone,
          email: r.email,
          docType: r.doc_type,
          challenges: r.challenges,
          faceScore: r.face_score,
          faceStatus: r.face_status,
          faceWarning: typeof r.face_score === 'number' && r.face_score < FACE_MATCH_WARN_BELOW,
          submittedAt: r.submitted_at,
          reviewedAt: r.reviewed_at,
          rejectionReason: r.rejection_reason,
          mediaPurged: Boolean(r.purged_at),
          attempts: Number(r.attempts ?? 0),
          duplicateFlag: Boolean(r.duplicate_flag),
          docExpiry: r.doc_expiry ?? null,
          ageHours: ageHours === null ? null : Math.floor(ageHours),
          sla:
            wanted !== 'submitted' || ageHours === null
              ? null
              : ageHours >= SLA_HOURS
                ? 'overdue'
                : ageHours >= SLA_WARN_HOURS
                  ? 'due_soon'
                  : 'ok',
        };
      }),
    };
  }

  /** Short-lived signed URLs. Every look at the raw files is itself audited. */
  async getMediaUrls(caseId: string, adminId: string) {
    const c = await this.requireCase(caseId);
    if (!c.doc_path || !c.liveness_paths?.length) {
      throw new NotFoundException('The files for this case were already deleted.');
    }
    const [document, ...frames] = await Promise.all(
      [c.doc_path, ...c.liveness_paths].map((p) =>
        this.storage.createSignedDownloadUrl(HOST_VERIFICATION_BUCKET, p, MEDIA_URL_SECONDS),
      ),
    );
    await this.audit(caseId, c.user_id, adminId, 'media_viewed', {});
    return { success: true, document, frames, expiresInSeconds: MEDIA_URL_SECONDS };
  }

  /** Admins may not decide their own case, and a banned admin may not decide anything. */
  private async assertMayDecide(adminId: string, subjectUserId: string): Promise<void> {
    if (adminId === subjectUserId) {
      throw new ForbiddenException('You cannot review your own verification.');
    }
    const admin = await this.users.findOne({ where: { id: adminId }, select: { id: true, banned_at: true } });
    if (admin?.banned_at) throw new ForbiddenException('This account cannot review verifications.');
  }

  async approve(caseId: string, adminId: string, checks: ApproveInput) {
    const c = await this.requireCase(caseId);
    await this.assertMayDecide(adminId, c.user_id);
    if (c.status !== 'submitted') throw new ConflictException('This case is not waiting for review.');
    if (!c.liveness_paths?.length) throw new ConflictException('This case has no live frames.');
    const verified = this.validateChecks(c.doc_type, checks);

    if (c.id_number_hash) {
      const other = await this.users.findOne({
        where: { id_number_salted_hash: c.id_number_hash, id: Not(c.user_id) },
        select: { id: true },
      });
      if (other) {
        throw new ConflictException('Another account already uses this ID. Reject this case instead.');
      }
    }

    // The one artefact we keep: the middle live frame, as the profile selfie. Done before the
    // decision so a storage failure cannot leave a verified host without a selfie.
    const keptFrame = c.liveness_paths[Math.floor(c.liveness_paths.length / 2)]!;
    const selfiePath = `${c.user_id}/selfie.jpg`;
    await this.storage.copy(HOST_VERIFICATION_BUCKET, keptFrame, HOST_SELFIE_BUCKET, selfiePath);

    const now = new Date();
    try {
      await this.dataSource.transaction(async (em) => {
        const res = await em.update(
          HostVerificationCaseEntity,
          { id: caseId, status: 'submitted' },
          {
            status: 'approved',
            reviewed_by: adminId,
            reviewed_at: now,
            doc_dob: verified.dob,
            doc_expiry: verified.expiry,
            adult_confirmed: true,
            expiry_confirmed: verified.expiry !== null,
          },
        );
        if (!res.affected) throw new ConflictException('This case was already decided.');
        await em.update(UserEntity, { id: c.user_id }, {
          is_id_verified: true,
          id_number_salted_hash: c.id_number_hash,
          id_doc_type: c.doc_type,
          id_verified_at: now,
          selfie_url: selfiePath,
          selfie_uploaded_at: now,
        });
      });
    } catch (err) {
      // The unique index on users.id_number_salted_hash is the race-proof duplicate check.
      if (isUniqueViolation(err)) {
        throw new ConflictException('Another account already uses this ID. Reject this case instead.');
      }
      throw err;
    }
    await this.audit(caseId, c.user_id, adminId, 'approved', {
      faceScore: c.face_score,
      adultConfirmed: true,
      expiryConfirmed: verified.expiry !== null,
    });
    this.notifications.notify(
      'verification.approved',
      c.user_id,
      { link: '/account?verify=1' },
      { dedupeKey: `verification:${caseId}:approved` },
    );

    const purged = await this.purgeCase(caseId).then(() => true).catch(() => false);
    return { success: true, purged };
  }

  private validateChecks(docType: string | null, checks: ApproveInput): { dob: string; expiry: string | null } {
    if (checks.adultConfirmed !== true) {
      throw new BadRequestException('Confirm that the person is 18 or older, or reject the case.');
    }
    const dob = parseIsoDate(checks.dateOfBirth);
    const today = new Date();
    if (!dob || dob.getTime() > today.getTime()) throw new BadRequestException('Enter a valid date of birth.');
    if (ageOn(dob, today) < MIN_HOST_AGE_YEARS) {
      throw new BadRequestException(`The host must be at least ${MIN_HOST_AGE_YEARS}. Reject this case.`);
    }
    // A masked Aadhaar prints no expiry date.
    if (docType === 'aadhaar_masked' && !checks.idExpiry) return { dob: checks.dateOfBirth, expiry: null };

    if (checks.notExpiredConfirmed !== true) {
      throw new BadRequestException('Confirm that the ID has not expired, or reject the case.');
    }
    const expiry = checks.idExpiry ? parseIsoDate(checks.idExpiry) : null;
    if (!expiry) throw new BadRequestException('Enter the expiry date printed on the ID.');
    const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    if (expiry.getTime() < startOfToday) throw new BadRequestException('This ID has expired. Reject this case.');
    return { dob: checks.dateOfBirth, expiry: checks.idExpiry! };
  }

  async reject(caseId: string, adminId: string, reason: string, ban: boolean) {
    const c = await this.requireCase(caseId);
    await this.assertMayDecide(adminId, c.user_id);
    if (c.status !== 'submitted') throw new ConflictException('This case is not waiting for review.');

    const now = new Date();
    await this.dataSource.transaction(async (em) => {
      const res = await em.update(
        HostVerificationCaseEntity,
        { id: caseId, status: 'submitted' },
        { status: 'rejected', rejection_reason: reason, reviewed_by: adminId, reviewed_at: now },
      );
      if (!res.affected) throw new ConflictException('This case was already decided.');
      if (ban) {
        // Keep the ID hash on the banned account so the same ID cannot register again.
        await em.update(UserEntity, { id: c.user_id }, {
          banned_at: now,
          id_number_salted_hash: c.id_number_hash,
        });
      }
    });
    await this.audit(caseId, c.user_id, adminId, 'rejected', { banned: ban });
    if (!ban) {
      this.notifications.notify(
        'verification.rejected',
        c.user_id,
        { reason, link: '/account?verify=1' },
        { dedupeKey: `verification:${caseId}:rejected` },
      );
    }

    const purged = await this.purgeCase(caseId).then(() => true).catch(() => false);
    return { success: true, purged };
  }

  /** Takes a verified host's status away (fraud found later, ID found fake, etc.). Audited and notified. */
  async revoke(userId: string, adminId: string, reason: string, ban: boolean) {
    await this.assertMayDecide(adminId, userId);
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, is_id_verified: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (!user.is_id_verified) throw new ConflictException('This user is not verified.');

    const now = new Date();
    const patch: Partial<UserEntity> = { is_id_verified: false, id_verified_at: null, id_doc_type: null };
    if (ban) patch.banned_at = now;
    await this.users.update({ id: userId }, patch);

    const lastApproved = await this.cases.findOne({
      where: { user_id: userId, status: 'approved' },
      order: { reviewed_at: 'DESC' },
      select: { id: true },
    });
    await this.audit(lastApproved?.id ?? null, userId, adminId, 'revoked', { reason, banned: ban });
    if (!ban) {
      this.notifications.notify(
        'verification.revoked',
        userId,
        { reason, link: '/account?verify=1' },
        { dedupeKey: `verification:${userId}:revoked:${now.getTime()}` },
      );
    }
    return { success: true };
  }

  /** Admin retry of the face-match score for a case still in the queue. */
  async rescore(caseId: string, adminId: string) {
    const c = await this.requireCase(caseId);
    if (c.status !== 'submitted') throw new ConflictException('This case is not waiting for review.');
    if (!c.doc_path || !c.liveness_paths?.length) throw new ConflictException('The files for this case are gone.');
    if (!this.faceMatch.isConfigured()) {
      throw new ServiceUnavailableException('Face matching is not configured. Compare the photos by eye.');
    }
    await this.audit(caseId, c.user_id, adminId, 'face_rescore_requested', {});
    const outcome = await this.rescoreCase(c);
    const fresh = await this.requireCase(caseId);
    return { success: true, outcome, faceStatus: fresh.face_status, faceScore: fresh.face_score };
  }

  // ------------------------------------------------------------------ purge + housekeeping

  /** Hard-deletes the raw ID image and live frames. Throws (after auditing) so callers can retry. */
  async purgeCase(caseId: string): Promise<void> {
    const c = await this.requireCase(caseId);
    const paths = [c.doc_path, ...(c.liveness_paths ?? [])].filter((p): p is string => Boolean(p));
    try {
      await this.storage.remove(HOST_VERIFICATION_BUCKET, paths);
    } catch (err) {
      await this.audit(caseId, c.user_id, null, 'purge_failed', { message: (err as Error).message });
      throw err;
    }
    await this.cases.update(
      { id: caseId },
      { doc_path: null, liveness_paths: null, id_number_hash: null, purged_at: new Date() },
    );
    await this.audit(caseId, c.user_id, null, 'purged', { files: paths.length });
  }

  /**
   * Expires abandoned/unreviewed cases (and tells the host), retries failed purges, and re-scores
   * cases whose face match is stuck pending.
   */
  async sweep(): Promise<{ expired: number; purged: number; rescored: number }> {
    const stale = await this.cases.find({
      where: { status: In([...OPEN_STATUSES]), expires_at: LessThan(new Date()) },
      select: { id: true, user_id: true, status: true },
      take: 100,
    });
    let expired = 0;
    for (const c of stale) {
      const res = await this.cases.update({ id: c.id, status: In([...OPEN_STATUSES]) }, { status: 'expired' });
      if (res.affected) {
        expired += 1;
        await this.audit(c.id, c.user_id, null, 'expired', { was: c.status });
        this.notifications.notify(
          'verification.expired',
          c.user_id,
          { wasSubmitted: c.status === 'submitted', link: '/account?verify=1' },
          { dedupeKey: `verification:${c.id}:expired` },
        );
      }
    }

    const leftovers = await this.cases
      .createQueryBuilder('c')
      .select('c.id', 'id')
      .where('c.status IN (:...done)', { done: ['approved', 'rejected', 'expired'] })
      .andWhere('c.purged_at IS NULL')
      .limit(100)
      .getRawMany<{ id: string }>();
    let purged = 0;
    for (const { id } of leftovers) {
      try {
        await this.purgeCase(id);
        purged += 1;
      } catch {
        // already audited as purge_failed; the next sweep tries again
      }
    }

    const rescored = await this.sweepStuckFaceScores().catch((err) => {
      this.logger.error('[sweep] face re-score failed', err as Error);
      return 0;
    });
    return { expired, purged, rescored };
  }

  /** Cases whose score never landed (worker down, process restarted mid-score) get another go. */
  private async sweepStuckFaceScores(): Promise<number> {
    if (!this.faceMatch.isConfigured()) return 0;
    const cutoff = new Date(Date.now() - FACE_STALE_MINUTES * 60_000);
    const stuck = await this.cases
      .createQueryBuilder('c')
      .where('c.status = :s AND c.face_status = :f AND c.submitted_at < :cutoff', {
        s: 'submitted',
        f: 'pending',
        cutoff,
      })
      .orderBy('c.submitted_at', 'ASC')
      .limit(5)
      .getMany();
    let rescored = 0;
    for (const c of stuck) {
      if (c.face_attempts >= FACE_MAX_AUTO_ATTEMPTS) {
        await this.cases.update({ id: c.id, face_status: 'pending' }, { face_status: 'unavailable' });
        await this.audit(c.id, c.user_id, null, 'face_scored', { status: 'unavailable', gaveUp: true });
        continue;
      }
      if ((await this.rescoreCase(c)) === 'scored') rescored += 1;
    }
    return rescored;
  }

  /** Downloads the stored (already re-encoded) files and scores them again. */
  private async rescoreCase(c: HostVerificationCaseEntity): Promise<'scored' | 'unavailable' | 'pending'> {
    if (!c.doc_path || !c.liveness_paths?.length) return 'unavailable';
    await this.cases.increment({ id: c.id }, 'face_attempts', 1);
    try {
      const fetchOne = async (path: string): Promise<Buffer> => {
        const url = await this.storage.createSignedDownloadUrl(HOST_VERIFICATION_BUCKET, path, 60);
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`download ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      };
      const [doc, ...frames] = await Promise.all([c.doc_path, ...c.liveness_paths].map(fetchOne));
      return await this.scoreBuffers(c.id, c.user_id, doc!, frames);
    } catch (err) {
      this.logger.warn(`[rescore] case ${c.id}: ${(err as Error).message}`);
      return 'pending';
    }
  }

  /**
   * Orphaned-file sweep (run hourly): users are deleted with ON DELETE CASCADE, which removes their
   * case rows but not the files. Finds storage folders whose user or case no longer exists (or whose
   * case is already purged) and deletes them.
   */
  async sweepOrphanedFiles(): Promise<{ removed: number }> {
    let removed = 0;
    const userFolders = (await this.storage.list(HOST_VERIFICATION_BUCKET, '', 500))
      .filter((f) => f.isFolder && UUID_RE.test(f.name))
      .map((f) => f.name);
    if (!userFolders.length) return { removed };

    const existing = new Set(
      (await this.users.find({ where: { id: In(userFolders) }, select: { id: true } })).map((u) => u.id),
    );
    for (const userId of userFolders) {
      const entries = await this.storage.list(HOST_VERIFICATION_BUCKET, userId, 200);
      const caseFolders = entries.filter((e) => e.isFolder && UUID_RE.test(e.name)).map((e) => e.name);
      let doomed = caseFolders;
      if (existing.has(userId) && caseFolders.length) {
        const live = await this.cases.find({
          where: { id: In(caseFolders), purged_at: IsNull() },
          select: { id: true },
        });
        const liveIds = new Set(live.map((c) => c.id));
        doomed = caseFolders.filter((id) => !liveIds.has(id));
      }
      for (const caseFolder of doomed) {
        const files = await this.storage.list(HOST_VERIFICATION_BUCKET, `${userId}/${caseFolder}`, 50);
        const paths = files.filter((f) => !f.isFolder).map((f) => `${userId}/${caseFolder}/${f.name}`);
        if (paths.length) {
          await this.storage.remove(HOST_VERIFICATION_BUCKET, paths);
          removed += paths.length;
        }
      }
      if (!existing.has(userId)) {
        await this.storage.remove(HOST_SELFIE_BUCKET, [`${userId}/selfie.jpg`]).catch(() => undefined);
      }
    }
    if (removed) this.logger.log(`[orphans] removed ${removed} orphaned verification file(s)`);
    return { removed };
  }

  // ------------------------------------------------------------------ helpers

  private requirePepper(): string {
    const pepper = this.config.get<string>('ID_HASH_PEPPER');
    if (!pepper || pepper.length < 32) {
      this.logger.error('ID_HASH_PEPPER is not configured (min 32 chars); host verification is disabled');
      throw new ServiceUnavailableException('Verification is temporarily unavailable.');
    }
    return pepper;
  }

  private async isPotentialDuplicate(idHash: string, userId: string): Promise<boolean> {
    const holder = await this.users.findOne({
      where: { id_number_salted_hash: idHash, id: Not(userId) },
      select: { id: true },
    });
    if (holder) return true;
    const otherCases = await this.cases.count({
      where: { id_number_hash: idHash, user_id: Not(userId), status: In(['submitted', 'approved']) },
    });
    return otherCases > 0;
  }

  private async scoreBuffers(
    caseId: string,
    userId: string,
    id: Buffer,
    frames: Buffer[],
  ): Promise<'scored' | 'unavailable' | 'pending'> {
    try {
      if (!this.faceMatch.isConfigured()) {
        await this.cases.update({ id: caseId }, { face_status: 'unavailable' });
        await this.audit(caseId, userId, null, 'face_scored', { status: 'unavailable' });
        return 'unavailable';
      }
      const result = await this.faceMatch.score(id, frames);
      if (result.status === 'scored') {
        await this.cases.update({ id: caseId }, { face_score: result.score, face_status: 'scored' });
        await this.audit(caseId, userId, null, 'face_scored', { score: result.score });
        return 'scored';
      }
      // Worker configured but failed: stay pending so the sweep (or an admin) retries.
      await this.audit(caseId, userId, null, 'face_score_failed', {});
      return 'pending';
    } catch (err) {
      this.logger.error(`[scoreBuffers] case ${caseId} failed`, err as Error);
      return 'pending';
    }
  }

  private async requireCase(caseId: string): Promise<HostVerificationCaseEntity> {
    const c = await this.cases.findOne({ where: { id: caseId } });
    if (!c) throw new NotFoundException('Verification case not found');
    return c;
  }

  private async audit(
    caseId: string | null,
    userId: string,
    actorId: string | null,
    action: string,
    meta: Record<string, unknown>,
  ) {
    await this.audits.save(
      this.audits.create({ case_id: caseId, user_id: userId, actor_id: actorId, action, meta }),
    );
  }

  private parseDocType(raw: string): IdDocType {
    if (!(ID_DOC_TYPES as readonly string[]).includes(raw)) {
      throw new BadRequestException('Choose a Driving Licence, Voter ID, Passport or masked Aadhaar.');
    }
    return raw as IdDocType;
  }

  private parseIdHash(docType: IdDocType, input: SubmitInput, pepper: string): string {
    // A masked Aadhaar exposes only the last 4 digits. We never accept or store an Aadhaar number;
    // the comparable hash is last4 + the name printed on the card.
    if (docType === 'aadhaar_masked') {
      const last4 = (input.aadhaarLast4 ?? '').trim();
      if (!/^\d{4}$/.test(last4)) throw new BadRequestException('Enter the last 4 digits shown on your masked Aadhaar.');
      const name = normalizeName(input.nameOnId ?? '');
      if (name.length < 3) throw new BadRequestException('Enter your name exactly as printed on the Aadhaar.');
      return hashMaskedAadhaar(last4, name, pepper);
    }

    const normalized = normalizeIdNumber(input.idNumber ?? '');
    if (looksLikeAadhaarNumber(normalized)) {
      throw new BadRequestException('Do not enter an Aadhaar number. Use a masked copy instead.');
    }
    if (!isPlausibleIdNumber(normalized)) {
      throw new BadRequestException('Enter the ID number exactly as printed on the document.');
    }
    return hashIdNumber(normalized, pepper);
  }

  /** The submitted challenges must be exactly the pair the server issued for this case. */
  private parseChallenges(raw: string[], issued: readonly string[]): string[] {
    const ok =
      raw.length === REQUIRED_CHALLENGES &&
      new Set(raw).size === REQUIRED_CHALLENGES &&
      issued.length === REQUIRED_CHALLENGES &&
      issued.every((c) => raw.includes(c));
    if (!ok) throw new BadRequestException('The liveness check was not completed.');
    return [...issued];
  }

  private async parseImages(input: SubmitInput) {
    const doc = input.document;
    if (!doc) throw new BadRequestException('Take a photo of your ID.');
    this.sniffWithinLimit(doc, 'ID photo');

    if (input.frames.length !== REQUIRED_FRAMES) {
      throw new BadRequestException('The liveness check must include 3 live frames.');
    }
    for (const f of input.frames) {
      const kind = this.sniffWithinLimit(f, 'Live frame');
      if (kind.mime !== 'image/jpeg') throw new BadRequestException('Live frames must be JPEG.');
    }

    const document = await reencodeToJpeg(doc.buffer, 'ID photo');
    const frames = await Promise.all(input.frames.map((f) => reencodeToJpeg(f.buffer, 'Live frame')));

    // Identical frames (or the ID photo reused as a frame) cannot be a live capture.
    const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const hashes = [hash(document.buffer), ...frames.map((f) => hash(f.buffer))];
    if (new Set(hashes).size !== hashes.length) {
      throw new BadRequestException('The live frames must be different captures.');
    }
    return { document, frames };
  }

  private sniffWithinLimit(file: UploadedImage, label: string) {
    if (file.size > MAX_IMAGE_BYTES) throw new BadRequestException(`${label} is too large.`);
    const kind = sniffImage(file.buffer);
    if (!kind) throw new BadRequestException(`${label} must be a JPEG or PNG image.`);
    return kind;
  }
}
