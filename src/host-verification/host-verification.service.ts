import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, LessThan, Not, Repository } from 'typeorm';
import { HostVerificationCaseEntity, UserEntity, VerificationAuditEntity } from '../entities';
import { StorageService } from '../storage/storage.service';
import { FaceMatchService } from './face-match.service';
import {
  CONSENT_VERSION,
  FACE_MATCH_WARN_BELOW,
  HOST_SELFIE_BUCKET,
  HOST_VERIFICATION_BUCKET,
  ID_DOC_TYPES,
  LIVENESS_CHALLENGES,
  MAX_IMAGE_BYTES,
  REQUIRED_CHALLENGES,
  REQUIRED_FRAMES,
  type IdDocType,
} from './host-verification.constants';
import { hashIdNumber, isPlausibleIdNumber, looksLikeAadhaarNumber, normalizeIdNumber } from './id-number.util';
import { sniffImage } from './image.util';

export type UploadedImage = { buffer: Buffer; size: number };

export type SubmitInput = {
  docType: string;
  idNumber?: string;
  challenges: string[];
  document: UploadedImage | undefined;
  frames: UploadedImage[];
};

const OPEN_CASE_DAYS_TO_START = 3;
const SUBMITTED_CASE_DAYS_TO_DECIDE = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const MEDIA_URL_SECONDS = 120;

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
  ) {}

  // ------------------------------------------------------------------ host side

  async getMyStatus(userId: string) {
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, is_id_verified: true, id_verified_at: true },
    });
    const latest = await this.cases.findOne({ where: { user_id: userId }, order: { created_at: 'DESC' } });
    return {
      isIdVerified: Boolean(user?.is_id_verified),
      verifiedAt: user?.id_verified_at ?? null,
      case: latest
        ? {
            id: latest.id,
            status: latest.status,
            rejectionReason: latest.status === 'rejected' ? latest.rejection_reason : null,
            submittedAt: latest.submitted_at,
          }
        : null,
    };
  }

  /** Purpose-limitation consent comes first; nothing is captured before this row exists. */
  async startConsent(userId: string, version: string) {
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

    const open = await this.cases.findOne({ where: { user_id: userId, status: In(['consented', 'submitted']) } });
    if (open) {
      if (open.status === 'submitted') {
        throw new ConflictException('Your verification is already with our team.');
      }
      await this.cases.update(
        { id: open.id },
        { expires_at: new Date(Date.now() + OPEN_CASE_DAYS_TO_START * DAY_MS) },
      );
      return { success: true, caseId: open.id };
    }

    const now = new Date();
    const inserted = await this.cases.insert({
      user_id: userId,
      status: 'consented',
      consent_version: CONSENT_VERSION,
      consent_at: now,
      expires_at: new Date(now.getTime() + OPEN_CASE_DAYS_TO_START * DAY_MS),
    });
    const caseId = inserted.identifiers[0]?.id as string;
    await this.audit(caseId, userId, userId, 'consented', { version: CONSENT_VERSION });
    return { success: true, caseId };
  }

  async submit(userId: string, caseId: string, input: SubmitInput) {
    const pepper = this.config.get<string>('ID_HASH_PEPPER');
    if (!pepper) {
      this.logger.error('ID_HASH_PEPPER is not configured; host verification is disabled');
      throw new ServiceUnavailableException('Verification is temporarily unavailable.');
    }

    const found = await this.cases.findOne({ where: { id: caseId, user_id: userId } });
    if (!found) throw new NotFoundException('Verification not found');
    if (found.status !== 'consented') throw new ConflictException('This verification was already submitted.');
    if (found.expires_at.getTime() < Date.now()) {
      throw new BadRequestException('This verification expired. Please start again.');
    }

    const docType = this.parseDocType(input.docType);
    const idHash = this.parseIdHash(docType, input.idNumber, pepper);
    const challenges = this.parseChallenges(input.challenges);
    const { document, frames } = this.parseImages(input);

    if (idHash) {
      const banned = await this.users.findOne({
        where: { id_number_salted_hash: idHash, banned_at: Not(IsNull()) },
        select: { id: true },
      });
      if (banned) {
        await this.audit(caseId, userId, null, 'blocked_banned_id', {});
        throw new ForbiddenException('We could not verify this ID.');
      }
    }

    const base = `${userId}/${caseId}`;
    const docPath = `${base}/id.${document.ext}`;
    const framePaths = frames.map((_, i) => `${base}/frame-${i + 1}.jpg`);
    const uploaded: string[] = [];
    try {
      await this.storage.uploadPrivate(HOST_VERIFICATION_BUCKET, docPath, document.buffer, document.mime);
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
        submitted_at: new Date(),
        expires_at: new Date(Date.now() + SUBMITTED_CASE_DAYS_TO_DECIDE * DAY_MS),
        face_status: 'pending',
      },
    );
    if (!res.affected) {
      await this.storage.remove(HOST_VERIFICATION_BUCKET, uploaded).catch(() => undefined);
      throw new ConflictException('This verification was already submitted.');
    }
    await this.audit(caseId, userId, userId, 'submitted', { docType, challenges });

    // Scored in the background from memory; the host is not kept waiting on the worker.
    void this.scoreInBackground(caseId, userId, document.buffer, frames.map((f) => f.buffer));

    return { success: true, status: 'submitted' as const };
  }

  // ------------------------------------------------------------------ admin side

  async listQueue(status: string | undefined) {
    const wanted = status && ['submitted', 'approved', 'rejected', 'expired'].includes(status) ? status : 'submitted';
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT c.id, c.user_id, c.status, c.doc_type, c.face_score, c.face_status, c.challenges,
              c.submitted_at, c.reviewed_at, c.rejection_reason, c.purged_at,
              u.full_name, u.phone, u.email
         FROM host_verification_cases c
         JOIN users u ON u.id = c.user_id
        WHERE c.status = $1
        ORDER BY c.submitted_at ASC NULLS LAST
        LIMIT 100`,
      [wanted],
    );
    return {
      success: true,
      items: rows.map((r) => ({
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
      })),
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

  async approve(caseId: string, adminId: string) {
    const c = await this.requireCase(caseId);
    if (c.status !== 'submitted') throw new ConflictException('This case is not waiting for review.');
    if (!c.liveness_paths?.length) throw new ConflictException('This case has no live frames.');

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
    await this.dataSource.transaction(async (em) => {
      const res = await em.update(
        HostVerificationCaseEntity,
        { id: caseId, status: 'submitted' },
        { status: 'approved', reviewed_by: adminId, reviewed_at: now },
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
    await this.audit(caseId, c.user_id, adminId, 'approved', { faceScore: c.face_score });

    const purged = await this.purgeCase(caseId).then(() => true).catch(() => false);
    return { success: true, purged };
  }

  async reject(caseId: string, adminId: string, reason: string, ban: boolean) {
    const c = await this.requireCase(caseId);
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

    const purged = await this.purgeCase(caseId).then(() => true).catch(() => false);
    return { success: true, purged };
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

  /** Expires abandoned cases and retries any purge that failed earlier. */
  async sweep(): Promise<{ expired: number; purged: number }> {
    const stale = await this.cases.find({
      where: { status: In(['consented', 'submitted']), expires_at: LessThan(new Date()) },
      select: { id: true, user_id: true },
      take: 100,
    });
    let expired = 0;
    for (const c of stale) {
      const res = await this.cases.update(
        { id: c.id, status: In(['consented', 'submitted']) },
        { status: 'expired' },
      );
      if (res.affected) {
        expired += 1;
        await this.audit(c.id, c.user_id, null, 'expired', {});
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
    return { expired, purged };
  }

  // ------------------------------------------------------------------ helpers

  private async scoreInBackground(caseId: string, userId: string, id: Buffer, frames: Buffer[]) {
    try {
      const result = await this.faceMatch.score(id, frames);
      if (result.status === 'scored') {
        await this.cases.update({ id: caseId }, { face_score: result.score, face_status: 'scored' });
        await this.audit(caseId, userId, null, 'face_scored', { score: result.score });
      } else {
        await this.cases.update({ id: caseId }, { face_status: 'unavailable' });
        await this.audit(caseId, userId, null, 'face_scored', { status: 'unavailable' });
      }
    } catch (err) {
      this.logger.error(`[scoreInBackground] case ${caseId} failed`, err as Error);
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

  private parseIdHash(docType: IdDocType, rawNumber: string | undefined, pepper: string): string | null {
    // A masked Aadhaar shows only the last 4 digits: there is nothing to hash, and we never accept
    // (or store) an Aadhaar number.
    if (docType === 'aadhaar_masked') return null;

    const normalized = normalizeIdNumber(rawNumber ?? '');
    if (looksLikeAadhaarNumber(normalized)) {
      throw new BadRequestException('Do not enter an Aadhaar number. Use a masked copy instead.');
    }
    if (!isPlausibleIdNumber(normalized)) {
      throw new BadRequestException('Enter the ID number exactly as printed on the document.');
    }
    return hashIdNumber(normalized, pepper);
  }

  private parseChallenges(raw: string[]): string[] {
    const unique = [...new Set(raw)];
    const valid = unique.every((c) => (LIVENESS_CHALLENGES as readonly string[]).includes(c));
    if (!valid || unique.length !== REQUIRED_CHALLENGES || raw.length !== REQUIRED_CHALLENGES) {
      throw new BadRequestException('The liveness check was not completed.');
    }
    return unique;
  }

  private parseImages(input: SubmitInput) {
    const doc = input.document;
    if (!doc) throw new BadRequestException('Take a photo of your ID.');
    const docKind = this.sniffWithinLimit(doc, 'ID photo');

    if (input.frames.length !== REQUIRED_FRAMES) {
      throw new BadRequestException('The liveness check must include 3 live frames.');
    }
    const frames = input.frames.map((f) => {
      const kind = this.sniffWithinLimit(f, 'Live frame');
      if (kind.mime !== 'image/jpeg') throw new BadRequestException('Live frames must be JPEG.');
      return { buffer: f.buffer };
    });
    return { document: { buffer: doc.buffer, ...docKind }, frames };
  }

  private sniffWithinLimit(file: UploadedImage, label: string) {
    if (file.size > MAX_IMAGE_BYTES) throw new BadRequestException(`${label} is too large.`);
    const kind = sniffImage(file.buffer);
    if (!kind) throw new BadRequestException(`${label} must be a JPEG or PNG image.`);
    return kind;
  }
}
