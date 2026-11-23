import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { BookingEntity, BookingEventEntity, BookingOfferEntity, ListingEntity } from '../entities';
import { calendarDayNumber } from '../common/calendar-date.util';
import { CalendarSyncService } from '../calendar-sync/calendar-sync.service';
import { NotificationsService } from '../notifications/notifications.service';
import { assertTransition, BookingStatus } from './booking-transitions';
import { assertBookableCompat } from './booking-eligibility.compat';
import {
  applyHostAdjustment,
  bookingAmountsFromSnapshot,
  computePriceSnapshot,
  DEFAULT_OFFER_ADJUST_MAX_PCT,
  DEFAULT_OFFER_TTL_HOURS,
  MAX_OFFER_TTL_HOURS,
  MIN_OFFER_TTL_HOURS,
  offerBounds,
  pricingFromPropertyDetails,
  PriceSnapshot,
  snapshotIsConsistent,
} from './offer-pricing.util';
import { CreateOfferDto } from './dto/offer.dto';
import { BLOCKING_STATUSES, HOST_PENDING_STATUSES, INSTANT_BOOKING_ENABLED, PAY_BY_TTL_MS } from './bookings.service';

const PG_UNIQUE_VIOLATION = '23505';
const PG_EXCLUSION_VIOLATION = '23P01';
const OFFER_REMINDER_LEAD_MS = 3 * 3600_000;
const MAX_KEY = 128;

const pgCode = (e: any): string | undefined => e?.code ?? e?.driverError?.code;
const pgConstraint = (e: any): string => e?.constraint ?? e?.driverError?.constraint ?? '';

export const OFFER_SWEEP_JOB = 'offers.expire-sweep';

/** What the client sees of an offer. Amounts come from the stored server snapshot only. */
export function offerView(o: BookingOfferEntity) {
  return {
    id: o.id,
    version: o.version,
    state: o.state,
    priceSnapshot: o.price_snapshot,
    total: o.price_snapshot.hostAdjustedTotal,
    conditions: o.conditions,
    hostMessage: o.host_message,
    expiresAt: o.expires_at,
    acceptedAt: o.accepted_at,
    createdAt: o.created_at,
  };
}

@Injectable()
export class BookingOffersService {
  private readonly logger = new Logger(BookingOffersService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ListingEntity) private readonly listingsRepo: Repository<ListingEntity>,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly calendarSync: CalendarSyncService,
  ) {
    // Instant booking is deliberately off: see INSTANT_BOOKING_ENABLED.
    if (INSTANT_BOOKING_ENABLED !== (false as boolean)) {
      throw new Error('Instant booking must stay disabled');
    }
  }

  // ---- config ------------------------------------------------------------
  private num(key: string, dflt: number): number {
    const v = Number(this.config?.get?.(key));
    return Number.isFinite(v) && v > 0 ? v : dflt;
  }
  maxAdjustPct(): number {
    return Math.min(this.num('OFFER_PRICE_ADJUST_MAX_PCT', DEFAULT_OFFER_ADJUST_MAX_PCT), 90);
  }
  private ttlHours(requested?: number): number {
    const h = requested ?? this.num('OFFER_TTL_HOURS', DEFAULT_OFFER_TTL_HOURS);
    return Math.min(Math.max(h, MIN_OFFER_TTL_HOURS), MAX_OFFER_TTL_HOURS);
  }
  private payByMs(): number {
    const h = Number(this.config?.get?.('BOOKING_PAY_BY_HOURS'));
    return Number.isFinite(h) && h > 0 ? h * 3600_000 : PAY_BY_TTL_MS;
  }

  // ---- helpers -----------------------------------------------------------
  private async loadBooking(id: string, manager?: EntityManager): Promise<BookingEntity> {
    const repo = manager ? manager.getRepository(BookingEntity) : this.dataSource.getRepository(BookingEntity);
    const b = await repo.findOne({ where: { id } });
    if (!b) throw new NotFoundException('Booking not found');
    return b;
  }

  private checkKey(key?: string): string | null {
    const k = key?.trim() || null;
    if (k && k.length > MAX_KEY) throw new BadRequestException('Idempotency-Key is too long.');
    return k;
  }

  private async lock(manager: EntityManager, key: string) {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
  }

  /** CAS status change + audit event on the same manager (mirrors BookingsService.transition). */
  private async move(
    manager: EntityManager,
    id: string,
    from: string,
    to: BookingStatus,
    actor: string | null,
    extra: Partial<BookingEntity> = {},
  ) {
    assertTransition(from, to);
    const res = await manager.update(BookingEntity, { id, status: from }, { ...extra, status: to, updated_at: new Date() });
    if (!res.affected) throw new ConflictException('Booking status changed during operation');
    await manager.getRepository(BookingEventEntity).insert({ booking_id: id, from_status: from, to_status: to, actor });
  }

  /** Non-transition audit entry (e.g. a revised offer while staying `offered`). */
  private async audit(manager: EntityManager, id: string, status: string, actor: string | null) {
    await manager.getRepository(BookingEventEntity).insert({ booking_id: id, from_status: status, to_status: status, actor });
  }

  private async overlaps(manager: EntityManager, b: BookingEntity): Promise<boolean> {
    const hit = await manager
      .getRepository(BookingEntity)
      .createQueryBuilder('b')
      .where('b.listing_id = :l', { l: b.listing_id })
      .andWhere('b.status IN (:...s)', { s: BLOCKING_STATUSES })
      .andWhere('b.move_in < :out', { out: b.move_out })
      .andWhere('COALESCE(b.actual_move_out, b.move_out) > :in', { in: b.move_in })
      .andWhere('b.id <> :id', { id: b.id })
      .getOne();
    return !!hit;
  }

  private async titleOf(listingId: string): Promise<string> {
    const l = await this.listingsRepo.findOne({ where: { id: listingId }, select: { draft_data: true } });
    return (l?.draft_data as any)?.property_details?.title ?? 'the listing';
  }

  /** Server-computed price for a booking row; never reads a client total. */
  async computeFor(b: BookingEntity, listing: ListingEntity): Promise<PriceSnapshot> {
    const nights = calendarDayNumber(b.move_out) - calendarDayNumber(b.move_in);
    const pricing = pricingFromPropertyDetails((listing.draft_data as any)?.property_details);
    return computePriceSnapshot(pricing, nights, (b.adults ?? 1) + (b.children ?? 0), b.payment_method === 'cash' ? 'cash' : 'upi');
  }

  // ---- host: open for review --------------------------------------------
  async markReview(hostId: string, bookingId: string) {
    const b = await this.loadBooking(bookingId);
    if (b.host_id !== hostId) throw new ForbiddenException('Forbidden');
    if (b.status === 'host_review') return { success: true, status: 'host_review' as const };
    if (b.status !== 'requested') throw new ConflictException(`Cannot review a booking in status "${b.status}"`);
    try {
      await this.dataSource.transaction((m) => this.move(m, bookingId, 'requested', 'host_review', hostId));
    } catch (e) {
      // Lost a race to another review/offer: replay-friendly if it is now host_review.
      if (e instanceof ConflictException) {
        const fresh = await this.loadBooking(bookingId);
        if (fresh.status === 'host_review') return { success: true, status: 'host_review' as const };
      }
      throw e;
    }
    return { success: true, status: 'host_review' as const };
  }

  // ---- read --------------------------------------------------------------
  async getOffer(userId: string, bookingId: string) {
    const b = await this.loadBooking(bookingId);
    const isHost = b.host_id === userId;
    if (!isHost && b.guest_id !== userId) throw new ForbiddenException('Forbidden');
    const offers = await this.dataSource
      .getRepository(BookingOfferEntity)
      .find({ where: { booking_id: bookingId }, order: { version: 'DESC' }, take: 1 });
    const offer = offers[0] ?? null;
    let preview: { snapshot: PriceSnapshot; min: number; max: number; maxPct: number; ttlHours: number } | null = null;
    if (isHost && [...HOST_PENDING_STATUSES, 'offered'].includes(b.status)) {
      const listing = await this.listingsRepo.findOne({ where: { id: b.listing_id } });
      if (listing) {
        const snapshot = await this.computeFor(b, listing);
        const maxPct = this.maxAdjustPct();
        preview = { snapshot, ...offerBounds(snapshot.computedTotal, maxPct), maxPct, ttlHours: this.ttlHours() };
      }
    }
    return {
      success: true,
      offer: offer ? offerView(offer) : null,
      preview,
      payByAt: b.pay_by_at,
      bookingStatus: b.status,
    };
  }

  // ---- host: create / revise --------------------------------------------
  async createOffer(
    actorId: string,
    bookingId: string,
    dto: CreateOfferDto,
    idempotencyKey?: string,
    adminOverride = false,
  ) {
    const key = this.checkKey(idempotencyKey);
    const booking = await this.loadBooking(bookingId);
    if (!adminOverride && booking.host_id !== actorId) throw new ForbiddenException('Forbidden');
    if (![...HOST_PENDING_STATUSES, 'offered'].includes(booking.status)) {
      throw new ConflictException(`Cannot make an offer on a booking in status "${booking.status}"`);
    }
    const listing = await this.listingsRepo.findOne({ where: { id: booking.listing_id } });
    if (!listing) throw new NotFoundException('Listing not found');
    assertBookableCompat(listing);
    if (new Date(`${booking.move_in}T00:00:00+05:30`).getTime() < Date.now() - 24 * 3600_000) {
      throw new BadRequestException('These dates are in the past.');
    }
    await this.calendarSync.assertDatesFree(booking.listing_id, booking.move_in, booking.move_out);

    const base = await this.computeFor(booking, listing);
    const snapshot = applyHostAdjustment(base, dto.adjustedTotal, this.maxAdjustPct(), adminOverride);
    const expiresAt = new Date(Date.now() + this.ttlHours(dto.expiresInHours) * 3600_000);
    const conditions = dto.conditions?.trim() || null;
    const hostMessage = dto.hostMessage?.trim() || null;

    let created: BookingOfferEntity;
    let replayed = false;
    try {
      created = await this.dataSource.transaction(async (m) => {
        await this.lock(m, `offer:${bookingId}`);
        const fresh = await this.loadBooking(bookingId, m);
        if (![...HOST_PENDING_STATUSES, 'offered'].includes(fresh.status)) {
          throw new ConflictException(`Cannot make an offer on a booking in status "${fresh.status}"`);
        }
        const repo = m.getRepository(BookingOfferEntity);
        if (key) {
          const dup = await repo.findOne({ where: { booking_id: bookingId, idempotency_key: key } });
          if (dup) {
            replayed = true;
            return dup;
          }
        }
        const pending = await repo.findOne({ where: { booking_id: bookingId, state: 'pending' } });
        if (
          pending &&
          pending.price_snapshot.hostAdjustedTotal === snapshot.hostAdjustedTotal &&
          (pending.conditions ?? null) === conditions &&
          (pending.host_message ?? null) === hostMessage
        ) {
          replayed = true; // identical re-post: same offer, no new version
          return pending;
        }
        if (await this.overlaps(m, fresh)) {
          throw new ConflictException('These dates are no longer available.');
        }
        if (pending) {
          await m.update(BookingOfferEntity, { id: pending.id, state: 'pending' }, { state: 'superseded' });
        }
        const last = await repo.find({ where: { booking_id: bookingId }, order: { version: 'DESC' }, take: 1 });
        const version = (last[0]?.version ?? 0) + 1;
        const row = repo.create({
          booking_id: bookingId,
          version,
          price_snapshot: snapshot,
          conditions,
          host_message: hostMessage,
          expires_at: expiresAt,
          state: 'pending',
          accepted_at: null,
          created_by: actorId,
          idempotency_key: key,
        });
        const saved = await repo.save(row);
        if (fresh.status === 'offered') await this.audit(m, bookingId, 'offered', actorId);
        else await this.move(m, bookingId, fresh.status, 'offered', actorId);
        return saved;
      });
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      if (pgCode(e) === PG_UNIQUE_VIOLATION) {
        // A concurrent offer won the unique-pending index: report, do not 500.
        throw new ConflictException('Another offer was created at the same time. Refresh and try again.');
      }
      this.logger.error('[createOffer] failed', e);
      throw new InternalServerErrorException('Could not create the offer.');
    }

    if (!replayed) {
      this.notifications.notify(
        'offer.sent',
        booking.guest_id,
        {
          listingTitle: (listing.draft_data as any)?.property_details?.title ?? 'the listing',
          pushTitle: 'You have an offer',
          pushBody: `Review and accept before ${expiresAt.toISOString()}`,
          link: `/booking/${bookingId}`,
        },
        { dedupeKey: `offer.sent:${created.id}` },
      );
    }
    return { success: true, replayed, offer: offerView(created), status: 'offered' as const };
  }

  // ---- guest: accept -----------------------------------------------------
  async acceptOffer(guestId: string, bookingId: string, idempotencyKey?: string) {
    this.checkKey(idempotencyKey); // accepted for API symmetry; accept is naturally idempotent
    const pre = await this.loadBooking(bookingId);
    if (pre.guest_id !== guestId) throw new ForbiddenException('Forbidden');
    if (pre.status === 'offered') {
      const listing = await this.listingsRepo.findOne({ where: { id: pre.listing_id } });
      if (!listing) throw new NotFoundException('Listing not found');
      assertBookableCompat(listing);
      await this.calendarSync.assertDatesFree(pre.listing_id, pre.move_in, pre.move_out);
    }
    const commissionPct = Number(this.config.get<number>('PLATFORM_COMMISSION_PERCENTAGE') ?? 0);

    type Outcome = { kind: 'ok' | 'replay'; offer: BookingOfferEntity; payByAt: Date | null } | { kind: 'expired' };
    let out: Outcome;
    try {
      out = await this.dataSource.transaction(async (m): Promise<Outcome> => {
        await this.lock(m, pre.listing_id);
        const b = await this.loadBooking(bookingId, m);
        const repo = m.getRepository(BookingOfferEntity);
        if (b.status === 'awaiting_payment' || b.status === 'confirmed') {
          const acc = (await repo.find({ where: { booking_id: bookingId, state: 'accepted' }, order: { version: 'DESC' }, take: 1 }))[0];
          if (acc) return { kind: 'replay', offer: acc, payByAt: b.pay_by_at };
        }
        if (b.status !== 'offered') throw new ConflictException(`Cannot accept an offer on a booking in status "${b.status}"`);
        const offer = await repo.findOne({ where: { booking_id: bookingId, state: 'pending' } });
        if (!offer) throw new ConflictException('There is no open offer to accept.');
        if (offer.expires_at.getTime() <= Date.now()) {
          await m.update(BookingOfferEntity, { id: offer.id, state: 'pending' }, { state: 'expired' });
          await this.move(m, bookingId, 'offered', 'expired', null);
          return { kind: 'expired' };
        }
        if (!snapshotIsConsistent(offer.price_snapshot)) {
          this.logger.error(`[acceptOffer] inconsistent snapshot on offer ${offer.id}`);
          throw new ConflictException('This offer is no longer valid. Ask the host for a new one.');
        }
        if (await this.overlaps(m, b)) throw new ConflictException('These dates are no longer available.');
        // CAS: of two concurrent accepts exactly one flips pending -> accepted.
        const res = await m.update(BookingOfferEntity, { id: offer.id, state: 'pending' }, { state: 'accepted', accepted_at: new Date() });
        if (!res.affected) throw new ConflictException('This offer was already answered.');
        const payByAt = new Date(Date.now() + this.payByMs());
        await this.move(m, bookingId, 'offered', 'awaiting_payment', guestId, {
          pay_by_at: payByAt,
          ...bookingAmountsFromSnapshot(offer.price_snapshot, commissionPct),
        });
        return { kind: 'ok', offer: { ...offer, state: 'accepted', accepted_at: new Date() }, payByAt };
      });
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      if (pgCode(e) === PG_EXCLUSION_VIOLATION) throw new ConflictException('These dates are no longer available.');
      throw e;
    }

    if (out.kind === 'expired') {
      throw new ConflictException('This offer has expired. Ask the host for a new one.');
    }
    if (out.kind === 'ok') {
      this.notifications.notify(
        'offer.accepted',
        pre.host_id,
        {
          listingTitle: await this.titleOf(pre.listing_id),
          pushTitle: 'Offer accepted',
          pushBody: 'Your guest accepted. Payment is next.',
          link: '/host?tab=bookings',
        },
        { dedupeKey: `offer.accepted:${out.offer.id}` },
      );
    }
    return {
      success: true,
      replayed: out.kind === 'replay',
      status: 'awaiting_payment' as const,
      payByAt: out.payByAt,
      offer: offerView(out.offer),
    };
  }

  // ---- guest: decline / host: withdraw ----------------------------------
  async declineOffer(guestId: string, bookingId: string, reason?: string) {
    const b = await this.loadBooking(bookingId);
    if (b.guest_id !== guestId) throw new ForbiddenException('Forbidden');
    return this.closeOffer(b, guestId, 'declined', 'cancelled', reason ?? 'Guest declined the offer');
  }

  async withdrawOffer(hostId: string, bookingId: string, reason?: string) {
    const b = await this.loadBooking(bookingId);
    if (b.host_id !== hostId) throw new ForbiddenException('Forbidden');
    return this.closeOffer(b, hostId, 'withdrawn', 'declined', reason ?? 'Host withdrew the offer');
  }

  private async closeOffer(
    b: BookingEntity,
    actor: string,
    state: 'declined' | 'withdrawn',
    to: BookingStatus,
    reason: string,
  ) {
    const terminal = to; // idempotent replay: already closed that way
    if (b.status === terminal) return { success: true, replayed: true, status: terminal };
    if (b.status !== 'offered') throw new ConflictException(`There is no open offer on a booking in status "${b.status}"`);
    await this.dataSource.transaction(async (m) => {
      const res = await m.update(BookingOfferEntity, { booking_id: b.id, state: 'pending' }, { state });
      if (!res.affected) throw new ConflictException('This offer was already answered.');
      await this.move(m, b.id, 'offered', to, actor, { rejection_reason: reason });
    });
    return { success: true, replayed: false, status: to };
  }

  // ---- sweep -------------------------------------------------------------
  /** Idempotent: expires overdue pending offers (and their booking) and sends the one-shot reminders. */
  async expireOffers(now = new Date()): Promise<{ expired: number; reminded: number }> {
    const repo = this.dataSource.getRepository(BookingOfferEntity);
    const overdue = await repo
      .createQueryBuilder('o')
      .where("o.state = 'pending'")
      .andWhere('o.expires_at < :now', { now })
      .limit(200)
      .getMany();
    let expired = 0;
    for (const o of overdue) {
      try {
        const done = await this.dataSource.transaction(async (m) => {
          const res = await m.update(BookingOfferEntity, { id: o.id, state: 'pending' }, { state: 'expired' });
          if (!res.affected) return false; // answered meanwhile
          const b = await this.loadBooking(o.booking_id, m);
          if (b.status === 'offered') await this.move(m, b.id, 'offered', 'expired', null);
          return b;
        });
        if (!done) continue;
        expired += 1;
        const b = done as BookingEntity;
        const listingTitle = await this.titleOf(b.listing_id);
        const data = { listingTitle, pushTitle: 'Offer expired', pushBody: 'The offer expired without an answer.', link: `/booking/${b.id}` };
        this.notifications.notify('offer.expired', b.guest_id, data, { dedupeKey: `offer.expired:${o.id}:guest` });
        this.notifications.notify('offer.expired', b.host_id, data, { dedupeKey: `offer.expired:${o.id}:host` });
      } catch (err) {
        if (!(err instanceof ConflictException)) this.logger.error(`[expireOffers] offer ${o.id} failed`, err as Error);
      }
    }

    const soon = await repo
      .createQueryBuilder('o')
      .where("o.state = 'pending'")
      .andWhere('o.expires_at >= :now', { now })
      .andWhere('o.expires_at < :lead', { lead: new Date(now.getTime() + OFFER_REMINDER_LEAD_MS) })
      .limit(200)
      .getMany();
    let reminded = 0;
    for (const o of soon) {
      const b = await this.dataSource.getRepository(BookingEntity).findOne({ where: { id: o.booking_id, status: In(['offered']) } });
      if (!b) continue;
      // dedupeKey makes this at-most-once per offer no matter how often the sweep runs.
      this.notifications.notify(
        'offer.expiring',
        b.guest_id,
        { listingTitle: await this.titleOf(b.listing_id), pushTitle: 'Your offer is expiring', pushBody: 'Accept it soon or it will lapse.', link: `/booking/${b.id}` },
        { dedupeKey: `offer.expiring:${o.id}` },
      );
      reminded += 1;
    }
    return { expired, reminded };
  }
}
