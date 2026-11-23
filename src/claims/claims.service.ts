import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { UserEntity } from '../entities';
import { SEARCH_CACHE_VERSION_KEY } from '../listings/listings.service';
import { RedisService } from '../redis/redis.service';
import { StorageService } from '../storage/storage.service';
import {
  CLAIM_EVIDENCE_BUCKET,
  CURRENT_CLAIM_TERMS_VERSION,
  DOCUMENT_KINDS,
  EDITABLE_STATES,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_FILES_PER_CLAIM,
  EVIDENCE_MIME,
  EVIDENCE_SIGNED_URL_TTL_SECONDS,
  MIN_AUTHORITY_STATEMENT,
  OPEN_STATES,
  REVIEWABLE_STATES,
  WITHDRAWABLE_STATES,
  type ClaimState,
  type EvidenceKind,
} from './claims.constants';
import { ClaimDisputeEntity, ClaimEvidenceEntity, ClaimEventEntity, PropertyClaimEntity, PropertyMemberEntity } from './claims.entities';
import {
  CLAIM_CRM_HOOK,
  CLAIM_INVITATION_LOOKUP,
  CLAIM_NOTIFIER,
  type ClaimNotifier,
  type CrmConversionHook,
  type InvitationLookup,
} from './claims.providers';

export interface UploadedEvidenceFile {
  buffer: Buffer;
  size: number;
  mimetype: string;
}

export const hashInvitationToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');
const rowsOf = (r: unknown): any[] => (Array.isArray(r) && Array.isArray(r[0]) ? (r[0] as any[]) : (r as any[]) ?? []);
const isUniqueViolation = (e: unknown): boolean => (e as { code?: string })?.code === '23505';

export const maskPhone = (p: string | null | undefined): string | null => (p ? `${'*'.repeat(Math.max(p.length - 4, 0))}${p.slice(-4)}` : null);
export const maskEmail = (e: string | null | undefined): string | null => {
  if (!e) return null;
  const [local, domain] = e.split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
};

/** Mask a business name for the candidate search: "Sunrise Cottage" -> "S****** C******". */
export const maskName = (name: string | null | undefined): string | null => {
  if (!name || !name.trim()) return null;
  return name.trim().split(/\s+/).slice(0, 4).map((w) => w[0] + '*'.repeat(Math.min(Math.max(w.length - 1, 1), 8))).join(' ');
};

@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(PropertyClaimEntity) private readonly claims: Repository<PropertyClaimEntity>,
    @InjectRepository(ClaimEvidenceEntity) private readonly evidence: Repository<ClaimEvidenceEntity>,
    @InjectRepository(ClaimEventEntity) private readonly events: Repository<ClaimEventEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly storage: StorageService,
    @Inject(CLAIM_INVITATION_LOOKUP) private readonly invitations: InvitationLookup,
    @Optional() @Inject(CLAIM_CRM_HOOK) private readonly crm?: CrmConversionHook,
    @Optional() @Inject(CLAIM_NOTIFIER) private readonly notifier?: ClaimNotifier,
    @Optional() private readonly redis?: RedisService,
  ) {}

  // ---------------------------------------------------------------- helpers

  private async event(em: EntityManager, claimId: string, actorId: string | null, actorRole: 'claimant' | 'admin' | 'system', action: string, meta: Record<string, unknown> = {}) {
    await em.insert(ClaimEventEntity, { claim_id: claimId, actor_id: actorId, actor_role: actorRole, action, meta: meta as any });
  }

  private async assertNotBanned(userId: string): Promise<void> {
    const u = await this.users.findOne({ where: { id: userId } });
    if (!u) throw new ForbiddenException('Account not found.');
    if (u.banned_at) throw new ForbiddenException('This account cannot claim properties.');
  }

  private async lockClaim(em: EntityManager, id: string): Promise<{ id: string; listing_id: string; claimant_user_id: string; state: ClaimState; role: 'owner' | 'manager' }> {
    const row = rowsOf(await em.query('SELECT id, listing_id, claimant_user_id, state, role FROM property_claims WHERE id = $1 FOR UPDATE', [id]))[0];
    if (!row) throw new NotFoundException('Claim not found.');
    return row;
  }

  private async lockListing(em: EntityManager, id: string): Promise<{ id: string; host_id: string | null; is_discovered: boolean }> {
    const row = rowsOf(await em.query('SELECT id, host_id, is_discovered FROM listings WHERE id = $1 FOR UPDATE', [id]))[0];
    if (!row) throw new NotFoundException('Property not found.');
    return row;
  }

  private assertClaimableListing(l: { host_id: string | null; is_discovered: boolean }): void {
    if (!l.is_discovered || l.host_id) throw new ConflictException('This property is not available to claim.');
  }

  private async ownClaim(userId: string, id: string): Promise<PropertyClaimEntity> {
    // IDOR: a claim that is not yours is indistinguishable from one that does not exist.
    const claim = await this.claims.findOne({ where: { id, claimant_user_id: userId } });
    if (!claim) throw new NotFoundException('Claim not found.');
    return claim;
  }

  private publicClaim(c: PropertyClaimEntity, evidence?: ClaimEvidenceEntity[]) {
    return {
      id: c.id, listingId: c.listing_id, role: c.role, state: c.state,
      businessName: c.business_name, contactPhone: c.contact_phone, contactEmail: c.contact_email,
      authorityStatement: c.authority_statement, termsVersion: c.terms_version, termsAcceptedAt: c.terms_accepted_at,
      infoRequestNote: c.info_request_note, decisionNote: c.state === 'REJECTED' ? c.decision_note : null,
      submittedAt: c.submitted_at, decidedAt: c.decided_at, createdAt: c.created_at,
      ...(evidence ? { evidence: evidence.filter((e) => !e.purged_at).map((e) => ({ id: e.id, kind: e.kind, mime: e.mime, size: e.size, uploadedAt: e.uploaded_at })) } : {}),
    };
  }

  // ---------------------------------------------------------------- claimant API

  /** Masked search over unclaimed candidates. Never returns contact details or exact names. */
  async searchCandidates(destination: string, q?: string) {
    const params: unknown[] = [`%${destination.trim().replace(/[%_\\]/g, '\\$&')}%`];
    let nameClause = '';
    if (q && q.trim()) {
      params.push(`%${q.trim().replace(/[%_\\]/g, '\\$&')}%`);
      nameClause = `AND COALESCE(draft_data #>> '{discovery,name}', '') ILIKE $2`;
    }
    const rows = rowsOf(await this.dataSource.query(
      `SELECT id,
              COALESCE(NULLIF(trim(draft_data #>> '{property_details,district}'), ''), '') AS district,
              COALESCE(NULLIF(trim(draft_data #>> '{property_details,town}'), ''), NULLIF(trim(draft_data #>> '{property_details,tehsil}'), ''), '') AS town,
              draft_data #>> '{discovery,name}' AS name
         FROM listings
        WHERE is_discovered = true AND host_id IS NULL AND status = 'discovered'
          AND (COALESCE(draft_data #>> '{property_details,district}', '') ILIKE $1
               OR COALESCE(draft_data #>> '{property_details,town}', '') ILIKE $1
               OR COALESCE(draft_data #>> '{property_details,tehsil}', '') ILIKE $1)
          ${nameClause}
        ORDER BY id LIMIT 20`,
      params,
    ));
    return rows.map((r) => ({ listingId: r.id as string, district: r.district as string, town: r.town as string, nameHint: maskName(r.name) }));
  }

  async start(userId: string, input: { invitationToken?: string; listingId?: string; role: 'owner' | 'manager' }) {
    if (!!input.invitationToken === !!input.listingId) {
      throw new BadRequestException('Provide either an invitation token or a property to claim.');
    }
    await this.assertNotBanned(userId);

    let listingId = input.listingId as string;
    let invitationId: string | null = null;
    let tokenHash: string | null = null;
    if (input.invitationToken) {
      tokenHash = hashInvitationToken(input.invitationToken);
      const inv = await this.invitations.find(tokenHash);
      // Expired, unknown and already-used tokens are deliberately indistinguishable.
      if (!inv) throw new GoneException('This invitation is invalid, expired or already used.');
      listingId = inv.listingId;
      invitationId = inv.invitationId;
    }

    try {
      return await this.dataSource.transaction(async (em) => {
        const listing = await this.lockListing(em, listingId);
        this.assertClaimableListing(listing);
        if (tokenHash && !(await this.invitations.consume(tokenHash, em, userId))) {
          throw new GoneException('This invitation is invalid, expired or already used.');
        }
        const claim = await em.save(em.create(PropertyClaimEntity, {
          listing_id: listingId, claimant_user_id: userId, role: input.role, state: 'DRAFT', invitation_id: invitationId,
        }));
        await this.event(em, claim.id, userId, 'claimant', 'created', { via: invitationId ? 'invitation' : 'search' });
        return this.publicClaim(claim, []);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('You already have an open claim on this property.');
      throw e;
    }
  }

  async listMine(userId: string) {
    const rows = await this.claims.find({ where: { claimant_user_id: userId }, order: { created_at: 'DESC' }, take: 100 });
    return rows.map((c) => this.publicClaim(c));
  }

  async getMine(userId: string, id: string) {
    const c = await this.ownClaim(userId, id);
    const ev = await this.evidence.find({ where: { claim_id: c.id }, order: { uploaded_at: 'ASC' } });
    return this.publicClaim(c, ev);
  }

  async saveDraft(userId: string, id: string, dto: { role?: 'owner' | 'manager'; businessName?: string; contactPhone?: string; contactEmail?: string; authorityStatement?: string; acceptTerms?: boolean }) {
    const c = await this.ownClaim(userId, id);
    if (!EDITABLE_STATES.includes(c.state)) throw new ConflictException('This claim can no longer be edited.');
    if (dto.role) c.role = dto.role;
    if (dto.businessName !== undefined) c.business_name = dto.businessName.trim() || null;
    if (dto.contactPhone !== undefined) c.contact_phone = dto.contactPhone.trim() || null;
    if (dto.contactEmail !== undefined) c.contact_email = dto.contactEmail.trim().toLowerCase() || null;
    if (dto.authorityStatement !== undefined) c.authority_statement = dto.authorityStatement.trim() || null;
    if (dto.acceptTerms === true) {
      c.terms_version = CURRENT_CLAIM_TERMS_VERSION;
      c.terms_accepted_at = new Date();
    }
    c.updated_at = new Date();
    await this.claims.save(c);
    await this.events.insert({ claim_id: c.id, actor_id: userId, actor_role: 'claimant', action: 'draft_saved', meta: {} });
    return this.publicClaim(c);
  }

  async uploadEvidence(userId: string, id: string, kind: string, file: UploadedEvidenceFile | undefined) {
    const c = await this.ownClaim(userId, id);
    if (!EDITABLE_STATES.includes(c.state)) throw new ConflictException('Evidence can no longer be added to this claim.');
    if (!file || !file.buffer?.length) throw new BadRequestException('Choose a file to upload.');
    if (!(['business_registration', 'ownership_document', 'management_agreement', 'utility_bill', 'property_photo', 'other'] as string[]).includes(kind)) {
      throw new BadRequestException('Unknown evidence type.');
    }
    if (file.size > EVIDENCE_MAX_BYTES || file.buffer.length > EVIDENCE_MAX_BYTES) {
      throw new PayloadTooLargeException(`Files must be ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB or smaller.`);
    }
    const spec = EVIDENCE_MIME[file.mimetype];
    if (!spec) throw new UnprocessableEntityException('Only PDF, JPEG, PNG or WebP files are accepted.');
    if (!spec.magic(file.buffer)) throw new UnprocessableEntityException('The file content does not match its type.');

    const active = (await this.evidence.find({ where: { claim_id: c.id } })).filter((e) => !e.purged_at);
    if (active.length >= EVIDENCE_MAX_FILES_PER_CLAIM) {
      throw new ConflictException(`A claim can hold at most ${EVIDENCE_MAX_FILES_PER_CLAIM} files.`);
    }
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    if (active.some((e) => e.sha256 === sha256)) throw new ConflictException('This file was already uploaded.');

    // Server-generated name: the client's file name is never used, so it cannot traverse or smuggle an extension.
    const path = `${c.id}/${randomUUID()}.${spec.ext}`;
    await this.storage.uploadPrivate(CLAIM_EVIDENCE_BUCKET, path, file.buffer, file.mimetype);
    const row = await this.evidence.save(this.evidence.create({
      claim_id: c.id, kind: kind as EvidenceKind, storage_path: path, mime: file.mimetype, size: file.buffer.length, sha256,
    }));
    await this.events.insert({ claim_id: c.id, actor_id: userId, actor_role: 'claimant', action: 'evidence_uploaded', meta: { evidenceId: row.id, kind } });
    return { id: row.id, kind: row.kind, mime: row.mime, size: row.size, uploadedAt: row.uploaded_at };
  }

  async deleteEvidence(userId: string, id: string, evidenceId: string) {
    const c = await this.ownClaim(userId, id);
    if (!EDITABLE_STATES.includes(c.state)) throw new ConflictException('Evidence can no longer be changed on this claim.');
    const ev = await this.evidence.findOne({ where: { id: evidenceId, claim_id: c.id } });
    if (!ev || ev.purged_at) throw new NotFoundException('Evidence not found.');
    await this.storage.remove(CLAIM_EVIDENCE_BUCKET, [ev.storage_path]);
    await this.evidence.update(ev.id, { purged_at: new Date() });
    await this.events.insert({ claim_id: c.id, actor_id: userId, actor_role: 'claimant', action: 'evidence_removed', meta: { evidenceId: ev.id } });
    return { success: true };
  }

  async submit(userId: string, id: string) {
    await this.assertNotBanned(userId);
    const c = await this.ownClaim(userId, id);
    if (!EDITABLE_STATES.includes(c.state)) throw new ConflictException('This claim has already been submitted.');
    if (!c.terms_accepted_at || !c.terms_version) throw new UnprocessableEntityException('Accept the claim terms before submitting.');
    if (!c.contact_phone && !c.contact_email) throw new UnprocessableEntityException('Add a contact phone or email.');
    if ((c.authority_statement ?? '').trim().length < MIN_AUTHORITY_STATEMENT) {
      throw new UnprocessableEntityException('Explain your authority over this property (a sentence or two).');
    }
    const active = (await this.evidence.find({ where: { claim_id: c.id } })).filter((e) => !e.purged_at);
    if (!active.some((e) => DOCUMENT_KINDS.includes(e.kind))) {
      throw new UnprocessableEntityException('Upload at least one supporting document (photos alone are not enough).');
    }

    return this.dataSource.transaction(async (em) => {
      const listing = await this.lockListing(em, c.listing_id);
      this.assertClaimableListing(listing);
      const locked = await this.lockClaim(em, c.id);
      if (!EDITABLE_STATES.includes(locked.state)) throw new ConflictException('This claim has already been submitted.');
      await em.update(PropertyClaimEntity, c.id, { state: 'SUBMITTED', submitted_at: new Date(), updated_at: new Date(), info_request_note: null });
      await this.event(em, c.id, userId, 'claimant', 'submitted');
      await this.syncDispute(em, c.listing_id);
      return { id: c.id, state: 'SUBMITTED' as ClaimState };
    });
  }

  async withdraw(userId: string, id: string) {
    const c = await this.ownClaim(userId, id);
    return this.dataSource.transaction(async (em) => {
      const locked = await this.lockClaim(em, c.id);
      if (!WITHDRAWABLE_STATES.includes(locked.state)) throw new ConflictException('This claim can no longer be withdrawn.');
      await em.update(PropertyClaimEntity, c.id, { state: 'WITHDRAWN', updated_at: new Date() });
      await this.event(em, c.id, userId, 'claimant', 'withdrawn');
      await this.syncDispute(em, c.listing_id);
      return { id: c.id, state: 'WITHDRAWN' as ClaimState };
    });
  }

  /** Open a dispute when >1 submitted claim competes for one listing; resolve it when only one remains. */
  private async syncDispute(em: EntityManager, listingId: string): Promise<void> {
    const competing = (await em.find(PropertyClaimEntity, { where: { listing_id: listingId } }))
      .filter((x) => (['SUBMITTED', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUIRED'] as ClaimState[]).includes(x.state));
    const open = await em.findOne(ClaimDisputeEntity, { where: { listing_id: listingId, resolved_at: IsNull() } });
    if (competing.length > 1) {
      const ids = competing.map((x) => x.id);
      if (open) await em.update(ClaimDisputeEntity, open.id, { claim_ids: ids });
      else {
        await em.insert(ClaimDisputeEntity, { listing_id: listingId, claim_ids: ids });
        for (const x of competing) await this.event(em, x.id, null, 'system', 'dispute_opened', { claimCount: ids.length });
      }
    } else if (open) {
      await em.update(ClaimDisputeEntity, open.id, { resolved_at: new Date(), resolution: 'no longer competing' });
    }
  }

  // ---------------------------------------------------------------- admin API

  /** Batch-load claimants and listings for the admin views (two queries regardless of page size). */
  private async adminContext(rows: PropertyClaimEntity[]) {
    const uids = [...new Set(rows.map((r) => r.claimant_user_id).filter(Boolean))];
    const lids = [...new Set(rows.map((r) => r.listing_id).filter(Boolean))];
    const [users, listings] = await Promise.all([
      uids.length ? this.dataSource.query(`SELECT id, full_name, email, phone FROM users WHERE id = ANY($1::uuid[])`, [uids]) : [],
      lids.length ? this.dataSource.query(`SELECT id, discovery_destination, discovery_state FROM listings WHERE id = ANY($1::uuid[])`, [lids]) : [],
    ]);
    return {
      users: new Map<string, any>((users as any[]).map((u) => [u.id, u])),
      listings: new Map<string, any>((listings as any[]).map((l) => [l.id, l])),
    };
  }

  private adminExtras(c: PropertyClaimEntity, ctx: { users: Map<string, any>; listings: Map<string, any> }, full: boolean) {
    const u = ctx.users.get(c.claimant_user_id);
    const l = ctx.listings.get(c.listing_id);
    return {
      claimant: u
        ? { id: u.id, name: u.full_name ?? null, email: full ? u.email ?? null : maskEmail(u.email), phone: full ? u.phone ?? null : maskPhone(u.phone) }
        : null,
      listing: l ? { id: l.id, destination: l.discovery_destination ?? null, discovery_state: l.discovery_state ?? null } : null,
    };
  }

  async adminList(f: { state?: string; listingId?: string; disputed?: boolean; page?: number; limit?: number }) {
    const limit = Math.min(Math.max(f.limit ?? 25, 1), 100);
    const page = Math.max(f.page ?? 1, 1);
    const qb = this.claims.createQueryBuilder('c').orderBy('c.submitted_at', 'ASC', 'NULLS LAST').addOrderBy('c.created_at', 'ASC');
    if (f.state) qb.andWhere('c.state = :state', { state: f.state });
    else qb.andWhere('c.state IN (:...open)', { open: OPEN_STATES.filter((s) => s !== 'DRAFT') });
    if (f.listingId) qb.andWhere('c.listing_id = :lid', { lid: f.listingId });
    if (f.disputed) {
      qb.andWhere('c.listing_id IN (SELECT listing_id FROM claim_disputes WHERE resolved_at IS NULL)');
    }
    const [rows, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
    const ctx = await this.adminContext(rows);
    return {
      items: rows.map((c) => ({ ...this.publicClaim(c), claimantUserId: c.claimant_user_id, ...this.adminExtras(c, ctx, false) })),
      total, page, limit,
    };
  }

  async adminGet(id: string) {
    const c = await this.claims.findOne({ where: { id } });
    if (!c) throw new NotFoundException('Claim not found.');
    const [ev, evs, dispute] = await Promise.all([
      this.evidence.find({ where: { claim_id: id }, order: { uploaded_at: 'ASC' } }),
      this.events.find({ where: { claim_id: id }, order: { at: 'ASC' } }),
      this.dataSource.getRepository(ClaimDisputeEntity).findOne({ where: { listing_id: c.listing_id, resolved_at: IsNull() } }),
    ]);
    const ctx = await this.adminContext([c]);
    return {
      ...this.publicClaim(c, ev), ...this.adminExtras(c, ctx, true), claimantUserId: c.claimant_user_id, reviewerId: c.reviewer_id, decisionNote: c.decision_note,
      dispute: dispute ? { id: dispute.id, claimIds: dispute.claim_ids, openedAt: dispute.opened_at } : null,
      events: evs.map((e) => ({ id: e.id, actorRole: e.actor_role, action: e.action, meta: e.meta, at: e.at })),
    };
  }

  /** Short-lived signed URL; every mint is audited. */
  async adminEvidenceUrl(adminId: string, claimId: string, evidenceId: string) {
    const ev = await this.evidence.findOne({ where: { id: evidenceId, claim_id: claimId } });
    if (!ev || ev.purged_at) throw new NotFoundException('Evidence not found.');
    const url = await this.storage.createSignedDownloadUrl(CLAIM_EVIDENCE_BUCKET, ev.storage_path, EVIDENCE_SIGNED_URL_TTL_SECONDS);
    await this.events.insert({ claim_id: claimId, actor_id: adminId, actor_role: 'admin', action: 'evidence_viewed', meta: { evidenceId } });
    return { url, expiresInSeconds: EVIDENCE_SIGNED_URL_TTL_SECONDS, mime: ev.mime };
  }

  private assertNotSelf(adminId: string, claimantId: string): void {
    if (adminId === claimantId) throw new ForbiddenException('You cannot review your own claim.');
  }

  private async transition(adminId: string, id: string, from: readonly ClaimState[], to: ClaimState, patch: Partial<PropertyClaimEntity>, action: string, meta: Record<string, unknown>) {
    return this.dataSource.transaction(async (em) => {
      const locked = await this.lockClaim(em, id);
      this.assertNotSelf(adminId, locked.claimant_user_id);
      if (!from.includes(locked.state)) throw new ConflictException(`Claim is ${locked.state}; this action is not allowed.`);
      await em.update(PropertyClaimEntity, id, { ...patch, state: to, reviewer_id: adminId, updated_at: new Date() });
      await this.event(em, id, adminId, 'admin', action, meta);
      return locked;
    });
  }

  async startReview(adminId: string, id: string) {
    await this.transition(adminId, id, ['SUBMITTED'], 'UNDER_REVIEW', {}, 'review_started', {});
    return { id, state: 'UNDER_REVIEW' as ClaimState };
  }

  async requestInfo(adminId: string, id: string, note: string) {
    const locked = await this.transition(adminId, id, REVIEWABLE_STATES, 'MORE_INFORMATION_REQUIRED', { info_request_note: note.trim() }, 'info_requested', { noteLength: note.length });
    this.safeNotify(locked.claimant_user_id, 'claim.more_info', { claimId: id, note: note.trim() });
    return { id, state: 'MORE_INFORMATION_REQUIRED' as ClaimState };
  }

  async reject(adminId: string, id: string, reason: string) {
    const locked = await this.dataSource.transaction(async (em) => {
      const l = await this.lockClaim(em, id);
      this.assertNotSelf(adminId, l.claimant_user_id);
      if (!(['SUBMITTED', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUIRED'] as ClaimState[]).includes(l.state)) {
        throw new ConflictException(`Claim is ${l.state}; this action is not allowed.`);
      }
      await em.update(PropertyClaimEntity, id, { state: 'REJECTED', reviewer_id: adminId, decided_at: new Date(), decision_note: reason.trim(), updated_at: new Date() });
      await this.event(em, id, adminId, 'admin', 'rejected', {});
      await this.syncDispute(em, l.listing_id);
      return l;
    });
    this.safeNotify(locked.claimant_user_id, 'claim.rejected', { claimId: id, note: reason.trim() });
    return { id, state: 'REJECTED' as ClaimState };
  }

  /**
   * Approve = ONE transaction: lock claim, lock listing row, hand the listing to the claimant as a DRAFT
   * (never live) only if it is still an unclaimed candidate, grant membership, auto-reject competitors.
   */
  async approve(adminId: string, id: string, note?: string) {
    const out = await this.dataSource.transaction(async (em) => {
      const claim = await this.lockClaim(em, id);
      this.assertNotSelf(adminId, claim.claimant_user_id);
      if (!REVIEWABLE_STATES.includes(claim.state)) throw new ConflictException(`Claim is ${claim.state}; only submitted claims can be approved.`);

      const claimant = await em.findOne(UserEntity, { where: { id: claim.claimant_user_id } });
      if (!claimant || claimant.banned_at) throw new ForbiddenException('The claimant account cannot be approved.');

      await this.lockListing(em, claim.listing_id);
      const updated = rowsOf(await em.query(
        `UPDATE listings SET host_id = $1, claimed_by = $1, claimed_at = now(), is_discovered = false,
                status = 'draft', updated_at = now(),
                draft_data = COALESCE(draft_data, '{}'::jsonb) - 'admin_only' - 'research'
          WHERE id = $2 AND is_discovered = true AND host_id IS NULL RETURNING id`,
        [claim.claimant_user_id, claim.listing_id],
      ));
      if (updated.length === 0) throw new ConflictException('This property was already claimed.');

      await em.update(PropertyClaimEntity, id, { state: 'APPROVED', reviewer_id: adminId, decided_at: new Date(), decision_note: note?.trim() || null, updated_at: new Date() });
      await em.query(
        `INSERT INTO property_members (listing_id, user_id, role, granted_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (listing_id, user_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, granted_at = now(), revoked_at = NULL`,
        [claim.listing_id, claim.claimant_user_id, claim.role, adminId],
      );
      await this.event(em, id, adminId, 'admin', 'approved', { listingStatus: 'draft' });

      const others = (await em.find(PropertyClaimEntity, { where: { listing_id: claim.listing_id } }))
        .filter((x) => x.id !== id && OPEN_STATES.includes(x.state));
      for (const o of others) {
        await em.update(PropertyClaimEntity, o.id, { state: 'REJECTED', reviewer_id: adminId, decided_at: new Date(), decision_note: 'Another claim on this property was approved.', updated_at: new Date() });
        await this.event(em, o.id, adminId, 'admin', 'auto_rejected', { winningClaimId: id });
      }
      const dispute = await em.findOne(ClaimDisputeEntity, { where: { listing_id: claim.listing_id, resolved_at: IsNull() } });
      if (dispute) await em.update(ClaimDisputeEntity, dispute.id, { resolved_by: adminId, resolved_at: new Date(), resolution: `approved claim ${id}` });
      return { claim, rejected: others };
    });

    // Best-effort side effects after commit; failures never undo an approval.
    try { await this.crm?.markConverted(out.claim.listing_id, out.claim.claimant_user_id); } catch { this.logger.warn('CRM markConverted failed'); }
    try { await this.redis?.incrementVersion(SEARCH_CACHE_VERSION_KEY); } catch { this.logger.warn('search cache bump failed'); }
    this.safeNotify(out.claim.claimant_user_id, 'claim.approved', { claimId: id });
    for (const o of out.rejected) this.safeNotify(o.claimant_user_id, 'claim.rejected', { claimId: o.id });
    return { id, state: 'APPROVED' as ClaimState, listingId: out.claim.listing_id, listingStatus: 'draft' };
  }

  private safeNotify(userId: string, event: Parameters<ClaimNotifier['notify']>[1], data: { claimId: string; note?: string }) {
    try { this.notifier?.notify(userId, event, data); } catch { this.logger.warn(`claim notify failed (${event})`); }
  }

  // ---------------------------------------------------------------- retention

  /** Deletes storage objects past retention_until, then marks purged_at. A failed delete is retried next run. */
  async purgeExpired(now: Date = new Date(), batch = 200): Promise<{ purged: number; failed: number }> {
    const due = await this.evidence.createQueryBuilder('e')
      .where('e.purged_at IS NULL AND e.retention_until <= :now', { now }).take(batch).getMany();
    let purged = 0; let failed = 0;
    for (const e of due) {
      try {
        await this.storage.remove(CLAIM_EVIDENCE_BUCKET, [e.storage_path]);
        await this.evidence.update(e.id, { purged_at: now });
        await this.events.insert({ claim_id: e.claim_id, actor_id: null, actor_role: 'system', action: 'evidence_purged', meta: { evidenceId: e.id } });
        purged++;
      } catch {
        failed++; // do not log paths or names
      }
    }
    return { purged, failed };
  }
}
