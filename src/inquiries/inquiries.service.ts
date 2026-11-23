import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, Like, MoreThan, Repository } from 'typeorm';
import {
  BookingEntity,
  InquiryEntity,
  InquiryEventEntity,
  InquiryMessageEntity,
  ListingEntity,
  UserEntity,
} from '../entities';
import type { InquiryState } from './inquiry.types';
import { GooglePlacesClient } from '../discovery/google-places.client';
import { isPrimaryAdmin } from '../common/primary-admin';
import { candidateReadiness } from './candidate-readiness';
import { InquiryAdminNotices } from './inquiry-admin-notices.service';
import { InquiryGuestNotices } from './inquiry-guest-notices.service';
import { InquiryNoticeCore, type NoticeResult } from './inquiry-notice-core.service';
import { InquiryOwnerRequestService, type SendToOwnerResult } from './inquiry-owner-request.service';
import { CreateInquiryDto, CreateMyInquiryDto } from './dto/create-inquiry.dto';
import { ListInquiriesQueryDto } from './dto/admin-inquiry.dto';
import {
  ACTIVE_STATES,
  SWEEPABLE_STATES,
  responseWindowMs,
  INQUIRY_CONSENT_VERSION,
  INQUIRY_DEDUPE_WINDOW_MS,
  PUBLIC_REF_RE,
  TERMINAL_STATES,
  canTransition,
  dedupeHash,
  dedupeKey,
  generateAccessToken,
  generatePublicRef,
  guestStatus,
  hashToken,
  tokenMatches,
  validateDates,
} from './inquiry.util';

const UNAVAILABLE = 'That stay is not available to request.';

export interface CreateInquiryResult {
  publicRef: string;
  /** Shown exactly once. null on a deduplicated repeat (the original link still works). */
  accessToken: string | null;
  duplicate: boolean;
}

/** Title/town of a verified live listing. Never called for candidates. */
export interface ListingLabel {
  id: string;
  title: string;
  town: string | null;
}

function labelOf(row: ListingEntity): ListingLabel {
  const d = (row.draft_data as Record<string, any>) ?? {};
  const p = d.property_details || d.property || d.basics || {};
  const loc = d.location || d.location_details || {};
  return { id: row.id, title: String(p.title ?? 'Stay'), town: (loc.town ?? loc.city ?? p.town ?? null) as string | null };
}

@Injectable()
export class InquiriesService {
  private readonly logger = new Logger(InquiriesService.name);

  constructor(
    @InjectRepository(InquiryEntity) private readonly inquiries: Repository<InquiryEntity>,
    @InjectRepository(InquiryMessageEntity) private readonly messages: Repository<InquiryMessageEntity>,
    @InjectRepository(InquiryEventEntity) private readonly events: Repository<InquiryEventEntity>,
    @InjectRepository(ListingEntity) private readonly listings: Repository<ListingEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(BookingEntity) private readonly bookings: Repository<BookingEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly core: InquiryNoticeCore,
    private readonly guestNotices: InquiryGuestNotices,
    private readonly adminNotices: InquiryAdminNotices,
    private readonly ownerRequest: InquiryOwnerRequestService,
    @Optional() private readonly places?: GooglePlacesClient,
  ) {}

  // ---------------------------------------------------------------- public

  /** E.164 from whatever the account stores ('+9198...', '98765 43210', '919876543210'). null when it cannot be a mobile number. */
  static toE164(raw: string | null | undefined): string | null {
    const digits = String(raw ?? '').replace(/[^\d+]/g, '');
    let e = digits;
    if (/^\d{10}$/.test(digits)) e = `+91${digits}`;
    else if (/^91\d{10}$/.test(digits)) e = `+${digits}`;
    else if (/^0\d{10}$/.test(digits)) e = `+91${digits.slice(1)}`;
    return /^\+[1-9]\d{7,14}$/.test(e) ? e : null;
  }

  /**
   * Logged-in request: no form. Contact details come from the account, and the guest is told on the button that
   * we will contact them about the request, so consent is recorded with its own text version.
   */
  async createForUser(userId: string, dto: CreateMyInquiryDto, opts: { tokenPhone?: string; now?: Date } = {}): Promise<CreateInquiryResult> {
    const now = opts.now ?? new Date();
    const user = await this.users.findOne({ where: { id: userId }, select: { id: true, full_name: true, phone: true, email: true } });
    if (!user) throw new BadRequestException('Please sign in again.');
    // The number they signed in with (verified by OTP, carried in the session) wins; the profile is only a backup.
    const phone = InquiriesService.toE164(opts.tokenPhone) ?? InquiriesService.toE164(user.phone);
    if (!phone) throw new BadRequestException('PHONE_REQUIRED: add your mobile number to your account so we can reach you about this request.');
    if (!dto.candidateRef && !dto.targetListingId) throw new BadRequestException(UNAVAILABLE);

    let destination: string | undefined;
    if (dto.candidateRef && !dto.targetListingId) {
      const c = await this.listings.findOne({ where: { id: dto.candidateRef, is_discovered: true }, select: { id: true, discovery_destination: true } });
      if (!c) throw new BadRequestException(UNAVAILABLE);
      destination = c.discovery_destination ?? undefined;
    }
    const guestName = (user.full_name ?? '').trim();
    return this.create(
      {
        guestName: guestName.length >= 2 ? guestName.slice(0, 80) : 'Guest',
        guestPhone: phone,
        guestEmail: user.email ?? undefined,
        candidateRef: dto.candidateRef,
        targetListingId: dto.targetListingId,
        destination,
        checkIn: dto.checkIn,
        checkOut: dto.checkOut,
        guests: dto.guests,
        consentContact: true,
      } as CreateInquiryDto,
      now,
      { userId, consentVersion: `${INQUIRY_CONSENT_VERSION}:account-request` },
    );
  }

  async create(dto: CreateInquiryDto, now = new Date(), opts: { userId?: string; consentVersion?: string } = {}): Promise<CreateInquiryResult> {
    if (dto.consentContact !== true) throw new BadRequestException('You must agree to be contacted about this request.');
    const dateError = validateDates(dto.checkIn, dto.checkOut, now);
    if (dateError) throw new BadRequestException(dateError);
    if (dto.budgetMin != null && dto.budgetMax != null && dto.budgetMax < dto.budgetMin) {
      throw new BadRequestException('Maximum budget cannot be below minimum budget.');
    }
    const destination = dto.destination?.trim() || null;
    if (!dto.targetListingId && !destination) {
      throw new BadRequestException('Tell us where you want to stay, or pick a stay to request.');
    }

    // Target must be a verified live listing. Discovered/unknown ids get the SAME error (no existence oracle).
    let targetId: string | null = null;
    if (dto.targetListingId) {
      const t = await this.findLiveListing(dto.targetListingId);
      if (!t) throw new BadRequestException(UNAVAILABLE);
      targetId = t.id;
    }

    // Candidate: resolved server-side only; unknown / non-discovered values are dropped silently.
    let candidateId: string | null = null;
    if (!targetId && dto.candidateRef) {
      const c = await this.listings.findOne({ where: { id: dto.candidateRef, is_discovered: true }, select: { id: true } });
      candidateId = c?.id ?? null;
    }

    const hash = dedupeHash({
      phone: dto.guestPhone,
      email: dto.guestEmail,
      targetListingId: targetId,
      destination,
      checkIn: dto.checkIn,
      checkOut: dto.checkOut,
    });
    const existing = await this.inquiries.findOne({
      where: { dedupe_key: Like(`${hash}:%`), created_at: MoreThan(new Date(now.getTime() - INQUIRY_DEDUPE_WINDOW_MS)) },
      order: { created_at: 'DESC' },
    });
    if (existing) return { publicRef: existing.public_ref, accessToken: null, duplicate: true };

    const token = generateAccessToken();
    const row = this.inquiries.create({
      public_ref: generatePublicRef(),
      access_token_hash: hashToken(token),
      guest_user_id: opts.userId ?? null,
      guest_name: dto.guestName.trim(),
      guest_phone: dto.guestPhone,
      guest_email: dto.guestEmail?.trim().toLowerCase() || null,
      target_listing_id: targetId,
      candidate_listing_id: candidateId,
      destination,
      check_in: dto.checkIn ?? null,
      check_out: dto.checkOut ?? null,
      guests: dto.guests ?? null,
      budget_min: dto.budgetMin ?? null,
      budget_max: dto.budgetMax ?? null,
      requirements: dto.requirements?.trim() || null,
      consent_contact: true,
      consent_at: now,
      consent_text_version: opts.consentVersion ?? INQUIRY_CONSENT_VERSION,
      state: 'NEW',
      response_due_at: new Date(now.getTime() + responseWindowMs(!!candidateId)),
      dedupe_key: dedupeKey(hash, now),
    });

    let saved: InquiryEntity;
    for (let attempt = 0; ; attempt++) {
      try {
        saved = await this.inquiries.save(row);
        break;
      } catch (e: any) {
        if (e?.code !== '23505') throw e;
        if (String(e?.constraint ?? e?.detail ?? '').includes('dedupe_key')) {
          const again = await this.inquiries.findOne({ where: { dedupe_key: row.dedupe_key } });
          if (again) return { publicRef: again.public_ref, accessToken: null, duplicate: true };
        }
        if (attempt >= 4) throw e;
        row.public_ref = generatePublicRef(); // ref collision: retry
      }
    }

    if (saved.requirements) {
      await this.messages.save(
        this.messages.create({ inquiry_id: saved.id, direction: 'internal', channel: 'internal', body: `Requirements: ${saved.requirements}`, actor_id: null }),
      );
    }
    await this.recordEvent(saved.id, 'created', null, 'NEW', null, {
      hasTarget: !!targetId,
      hasCandidate: !!candidateId,
      consentVersion: INQUIRY_CONSENT_VERSION,
    });
    const owner = await this.autoAssign(saved).catch((e) => {
      this.logger.warn(`auto-assign failed: ${e?.message ?? e}`);
      return null;
    });
    // Best-effort, each on its own: a failed consent grant or notice never fails or rolls back the request.
    await this.core.grantGuestConsentOnCreate(saved).catch((e) => this.logger.warn(`consent grant failed: ${e?.message ?? e}`));
    await this.guestNotices.received(saved).catch((e) => this.logger.warn(`guest notice failed: ${e?.message ?? e}`));
    await this.adminNotices.newRequest(saved, owner).catch((e) => this.logger.warn(`admin notice failed: ${e?.message ?? e}`));
    return { publicRef: saved.public_ref, accessToken: token, duplicate: false };
  }

  /** Guest status view. Uniform 404 for unknown ref OR wrong token. Never includes internal data. */
  async getPublic(ref: string, token: string | undefined) {
    if (!PUBLIC_REF_RE.test(ref ?? '')) throw new NotFoundException('Request not found.');
    const inq = await this.inquiries.findOne({ where: { public_ref: ref } });
    if (!inq || !tokenMatches(token, inq.access_token_hash)) throw new NotFoundException('Request not found.');

    const hasCandidate = !!inq.candidate_listing_id;
    const status = guestStatus(inq.state, hasCandidate);
    const propId = inq.candidate_listing_id ?? inq.target_listing_id;
    const row = propId
      ? await this.listings.findOne({ where: { id: propId }, select: { id: true, draft_data: true, disc_district: true, discovery_destination: true } })
      : null;
    const property = row
      ? { id: row.id, title: labelOf(row).title, town: row.disc_district || row.discovery_destination || inq.destination || '' }
      : null;
    const town = property?.town ?? inq.destination ?? '';
    return {
      ref: inq.public_ref,
      status,
      isRequestOnly: true,
      createdAt: inq.created_at,
      respondBy: status === 'received' ? inq.response_due_at : null,
      guestName: inq.guest_name,
      destination: inq.destination,
      checkIn: inq.check_in,
      checkOut: inq.check_out,
      guests: inq.guests,
      requirements: inq.requirements,
      property,
      bookingId: inq.state === 'CONVERTED' ? inq.converted_booking_id : null,
      staysPath: status === 'unavailable' ? this.core.staysPath(town) : null,
    };
  }

  // ----------------------------------------------------------------- admin

  async list(q: ListInquiriesQueryDto) {
    const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(q.pageSize ?? '20', 10) || 20));
    const qb = this.inquiries.createQueryBuilder('i');
    if (q.state) qb.andWhere('i.state = :state', { state: q.state });
    if (q.assignee === 'unassigned') qb.andWhere('i.assigned_to IS NULL');
    else if (q.assignee) {
      if (!/^[0-9a-f-]{36}$/i.test(q.assignee)) throw new BadRequestException('assignee must be a user id or "unassigned".');
      qb.andWhere('i.assigned_to = :assignee', { assignee: q.assignee });
    }
    if (q.overdue === 'true') qb.andWhere('i.state IN (:...active) AND i.response_due_at < now()', { active: ACTIVE_STATES });
    if (q.destination) qb.andWhere('i.destination ILIKE :dest', { dest: `%${escapeLike(q.destination)}%` });
    if (q.q) {
      qb.andWhere(
        '(i.public_ref ILIKE :s OR i.guest_name ILIKE :s OR i.destination ILIKE :s OR i.guest_phone ILIKE :s OR i.guest_email ILIKE :s)',
        { s: `%${escapeLike(q.q)}%` },
      );
    }
    qb.orderBy('i.created_at', 'DESC').skip((page - 1) * pageSize).take(pageSize);
    const [rows, total] = await qb.getManyAndCount();
    const now = Date.now();
    return {
      items: rows.map((r) => ({ ...this.adminView(r), overdue: ACTIVE_STATES.includes(r.state) && r.response_due_at.getTime() < now })),
      total,
      page,
      pageSize,
    };
  }

  async detail(id: string) {
    const inq = await this.mustGet(id);
    const [msgs, evts, candidate] = await Promise.all([
      this.messages.find({ where: { inquiry_id: id, direction: 'internal' }, order: { at: 'ASC' } }),
      this.events.find({ where: { inquiry_id: id }, order: { at: 'ASC' } }),
      this.candidateFor(inq),
    ]);
    let bookingReference: string | null = null;
    if (inq.state === 'CONVERTED' && inq.converted_booking_id) {
      const b = await this.bookings.findOne({ where: { id: inq.converted_booking_id }, select: { id: true, reference: true } });
      bookingReference = b?.reference ?? null;
    }
    const notices = evts
      .filter((e) => e.type === 'notice')
      .map((e) => {
        const m = (e.meta ?? {}) as Record<string, any>;
        return { kind: m.kind, to: m.to, channel: m.channel, status: m.status, ...(m.reason ? { reason: m.reason } : {}), at: e.at };
      });
    return {
      ...this.adminView(inq),
      has_account: inq.guest_user_id != null,
      messages: msgs.map((m) => ({ author: m.actor_id, body: m.body, created_at: m.at })),
      events: evts,
      candidate,
      convertedBookingId: inq.state === 'CONVERTED' ? inq.converted_booking_id : null,
      bookingReference,
      notices,
    };
  }

  /**
   * The unclaimed property the guest asked about, with the owner's contact so staff can call and invite them to
   * onboard. Name, address and phone come live from Google for this one admin view only: never stored, cached or logged.
   */
  private async candidateFor(inq: InquiryEntity) {
    if (!inq.candidate_listing_id) return null;
    const row = await this.listings.findOne({
      where: { id: inq.candidate_listing_id },
      select: {
        id: true,
        external_place_id: true,
        discovery_destination: true,
        disc_district: true,
        disc_tehsil: true,
        is_discovered: true,
        status: true,
        host_id: true,
        booking_eligible: true,
        claimed_at: true,
      },
    });
    const base = {
      listingId: row?.id ?? inq.candidate_listing_id,
      destination: row?.discovery_destination ?? null,
      district: row?.disc_district ?? null,
      tehsil: row?.disc_tehsil ?? null,
      claimed: row ? !row.is_discovered : false,
      town: row ? row.disc_district || row.discovery_destination || inq.destination || null : inq.destination ?? null,
      ready: candidateReadiness(row as any, inq) as { ok: boolean; reason?: string },
    };
    if (!row) return { ...base, name: null, address: null, phone: null, mapsUrl: null };
    if (!this.places || !row.external_place_id) return { ...base, name: null, address: null, phone: null, mapsUrl: null };
    const budget = Number(process.env.DISCOVERED_DETAILS_DAILY_BUDGET ?? 1000);
    const c = await this.places.getContact(row.external_place_id, budget).catch(() => null);
    return { ...base, name: c?.name ?? null, address: c?.address ?? null, phone: c?.phone ?? null, mapsUrl: c?.mapsUrl ?? null };
  }

  async assign(id: string, assigneeId: string | null, actorId: string) {
    const inq = await this.mustGet(id);
    this.assertActive(inq);
    if (assigneeId) {
      const u = await this.users.findOne({ where: { id: assigneeId }, select: { id: true, role: true } });
      if (!u || u.role !== 'admin') throw new BadRequestException('Assignee must be an admin user.');
    }
    inq.assigned_to = assigneeId;
    await this.inquiries.save(inq);
    await this.recordEvent(id, 'assigned', inq.state, inq.state, actorId, { assigneeId });
    if (assigneeId && inq.state === 'NEW') return this.transition(inq, 'ASSIGNED', actorId);
    return this.adminView(inq);
  }

  // ------------------------------------------------- the three admin actions

  /**
   * Runs one admin action under a row lock in ONE transaction: re-reads the inquiry FOR UPDATE, lets `decide`
   * refuse (nothing written) or return the target state, then writes the optional internal note, the state
   * change and one event. Notices are the caller's job, after commit.
   */
  private async lockedAction(
    id: string,
    actorId: string,
    note: string | undefined,
    action: string,
    decide: (inq: InquiryEntity) => { to: InquiryState; meta?: Record<string, unknown> } | 'noop',
  ): Promise<{ inq: InquiryEntity; changed: boolean }> {
    return this.dataSource.transaction(async (m) => {
      const inq = await m.getRepository(InquiryEntity).createQueryBuilder('i').setLock('pessimistic_write').where('i.id = :id', { id }).getOne();
      if (!inq) throw new NotFoundException('Inquiry not found.');
      const d = decide(inq);
      if (d === 'noop') return { inq, changed: false };
      const from = inq.state;
      const text = note?.trim();
      if (text) {
        await m.getRepository(InquiryMessageEntity).insert({ inquiry_id: id, direction: 'internal', channel: 'internal', body: text, actor_id: actorId });
      }
      inq.state = d.to;
      if (!inq.first_response_at) inq.first_response_at = new Date();
      await m.getRepository(InquiryEntity).save(inq);
      await m.getRepository(InquiryEventEntity).insert({
        inquiry_id: id,
        type: 'state_changed',
        from_state: from,
        to_state: d.to,
        actor_id: actorId,
        meta: { action, from, to: d.to, ...(text ? { note: true } : {}), ...(d.meta ?? {}) },
      });
      return { inq, changed: true };
    });
  }

  private closedError(state: string) {
    return new ConflictException({ code: 'ALREADY_CLOSED', message: `This request is already closed (${state}).` });
  }

  async contacting(id: string, actorId: string, note?: string): Promise<{ id: string; state: InquiryState; changed: boolean }> {
    const r = await this.lockedAction(id, actorId, note, 'contacting', (inq) => {
      if (inq.state === 'HOST_CONTACTING') return 'noop';
      if (!canTransition(inq.state, 'HOST_CONTACTING')) throw this.closedError(inq.state);
      return { to: 'HOST_CONTACTING' };
    });
    return { id, state: r.inq.state, changed: r.changed };
  }

  async notAvailable(id: string, actorId: string, note?: string): Promise<{ id: string; state: InquiryState; changed: boolean; notices: NoticeResult }> {
    const r = await this.lockedAction(id, actorId, note, 'dates_unavailable', (inq) => {
      if (inq.state === 'DECLINED' || inq.state === 'EXPIRED') return 'noop';
      if (!canTransition(inq.state, 'DECLINED')) throw this.closedError(inq.state);
      return { to: 'DECLINED' };
    });
    // Already DECLINED/EXPIRED: no resend.
    const skipped: NoticeResult = { email: 'duplicate', whatsapp: 'duplicate' };
    const notices = r.changed ? await this.safeUnavailable(r.inq, 'admin') : skipped;
    return { id, state: r.inq.state, changed: r.changed, notices };
  }

  /** Guest notices never fail the action. */
  private async safeUnavailable(inq: InquiryEntity, reason: 'admin' | 'sweep'): Promise<NoticeResult> {
    try {
      return await this.guestNotices.datesUnavailable(inq, reason);
    } catch (e: any) {
      this.logger.warn(`unavailable notice failed: ${e?.message ?? e}`);
      return { email: 'failed', whatsapp: 'failed' };
    }
  }

  /** Creates the normal booking request on the now-claimed listing. Delegated: this is the only path to the bookings service. */
  sendToOwner(id: string, actorId: string, note?: string): Promise<SendToOwnerResult> {
    return this.ownerRequest.sendToOwner(id, actorId, note);
  }

  /**
   * Analytics over inquiries CREATED in the last `days` days.
   * avgFirstResponse = numeratorSeconds / denominator, where denominator = inquiries in the window that
   * HAVE a first_response_at (first staff 'out' message) and numeratorSeconds = sum(first_response_at - created_at).
   * Inquiries not yet answered are excluded from the average and reported as `awaitingFirstResponse`.
   */
  async analytics(days = 30) {
    const d = Math.min(365, Math.max(1, Math.floor(days) || 30));
    const since = new Date(Date.now() - d * 86_400_000);
    const byState = await this.inquiries
      .createQueryBuilder('i')
      .select('i.state', 'state')
      .addSelect('count(*)::int', 'n')
      .where('i.created_at >= :since', { since })
      .groupBy('i.state')
      .getRawMany<{ state: string; n: number }>();
    const fr = await this.inquiries
      .createQueryBuilder('i')
      .select('coalesce(sum(extract(epoch from (i.first_response_at - i.created_at))),0)::float8', 'numerator')
      .addSelect('count(*)::int', 'denominator')
      .where('i.created_at >= :since AND i.first_response_at IS NOT NULL', { since })
      .getRawOne<{ numerator: number; denominator: number }>();
    const open = await this.inquiries
      .createQueryBuilder('i')
      .select('count(*) FILTER (WHERE i.response_due_at < now())::int', 'overdue')
      .addSelect('count(*) FILTER (WHERE i.assigned_to IS NULL)::int', 'unassigned')
      .addSelect('count(*) FILTER (WHERE i.first_response_at IS NULL)::int', 'awaiting')
      .where('i.state IN (:...active)', { active: ACTIVE_STATES })
      .getRawOne<{ overdue: number; unassigned: number; awaiting: number }>();
    const counts = Object.fromEntries(byState.map((r) => [r.state, Number(r.n)]));
    const numerator = Number(fr?.numerator ?? 0);
    const denominator = Number(fr?.denominator ?? 0);
    return {
      windowDays: d,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      byState: counts,
      open: { overdue: Number(open?.overdue ?? 0), unassigned: Number(open?.unassigned ?? 0), awaitingFirstResponse: Number(open?.awaiting ?? 0) },
      firstResponse: {
        numeratorSeconds: numerator,
        denominator,
        avgSeconds: denominator > 0 ? Math.round(numerator / denominator) : null,
      },
    };
  }

  /** Expire active inquiries past their response deadline. Idempotent; returns the number expired. */
  async sweepExpired(now = new Date()): Promise<number> {
    const due = await this.inquiries.find({
      where: { state: In([...SWEEPABLE_STATES]), response_due_at: LessThan(now) },
      order: { response_due_at: 'ASC' },
      take: 500,
    });
    let n = 0;
    for (const inq of due) {
      const from = inq.state;
      try {
        // Guarded update: only expire if still sweepable and overdue (an admin action may have won the race).
        const res = await this.inquiries
          .createQueryBuilder()
          .update(InquiryEntity)
          .set({ state: 'EXPIRED' as InquiryState })
          .where('id = :id AND state IN (:...st) AND response_due_at < :now', { id: inq.id, st: [...SWEEPABLE_STATES], now })
          .execute();
        if (!res.affected) continue;
        inq.state = 'EXPIRED' as InquiryState;
        await this.recordEvent(inq.id, 'state_changed', from, 'EXPIRED', null, { reason: 'response_deadline_passed' });
        n++;
        if (inq.candidate_listing_id) await this.safeUnavailable(inq, 'sweep');
      } catch (e: any) {
        this.logger.warn(`expire ${inq.public_ref} failed: ${e?.message ?? e}`);
      }
    }
    return n;
  }

  // --------------------------------------------------------------- helpers

  private async transition(inq: InquiryEntity, to: InquiryState, actorId: string | null, meta: Record<string, unknown> = {}) {
    const from = inq.state;
    if (!canTransition(from, to)) throw new ConflictException(`Cannot move an inquiry from ${from} to ${to}.`);
    inq.state = to;
    await this.inquiries.save(inq);
    await this.recordEvent(inq.id, 'state_changed', from, to, actorId, meta);
    return this.adminView(inq);
  }

  private assertActive(inq: InquiryEntity) {
    if (TERMINAL_STATES.includes(inq.state)) throw new ConflictException(`Inquiry is ${inq.state}.`);
  }

  private async mustGet(id: string) {
    const inq = await this.inquiries.findOne({ where: { id } });
    if (!inq) throw new NotFoundException('Inquiry not found.');
    return inq;
  }

  private findLiveListing(id: string) {
    return this.listings
      .findOne({ where: { id, status: 'live', is_discovered: false } })
      .then((l) => (l && l.host_id ? l : null));
  }

  private recordEvent(inquiryId: string, type: string, from: string | null, to: string | null, actorId: string | null, meta: Record<string, unknown>) {
    return this.events.save(this.events.create({ inquiry_id: inquiryId, type, from_state: from, to_state: to, actor_id: actorId, meta }));
  }

  /** Staff view: full contact details, never the token hash. */
  private adminView(i: InquiryEntity) {
    const { access_token_hash: _omit, ...rest } = i;
    return rest;
  }

  /** New requests go straight to the primary admin (state NEW -> ASSIGNED, recorded as a system action). */
  private async autoAssign(inq: InquiryEntity): Promise<string | null> {
    const admins = await this.users.find({ where: { role: 'admin' }, select: { id: true, email: true }, take: 50 });
    const owner = admins.find((a) => isPrimaryAdmin(a.email));
    if (!owner) return null;
    inq.assigned_to = owner.id;
    await this.inquiries.save(inq);
    await this.recordEvent(inq.id, 'assigned', inq.state, inq.state, null, { assigneeId: owner.id, auto: true });
    await this.transition(inq, 'ASSIGNED', null, { auto: true });
    return owner.id;
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
