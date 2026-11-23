import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  LessThan,
  LessThanOrEqual,
  Repository,
} from 'typeorm';
import { randomInt, randomUUID, timingSafeEqual } from 'crypto';
import {
  BookingEntity,
  BookingEventEntity,
  ListingEntity,
  PaymentEntity,
  UserEntity,
  BookingOfferEntity,
} from '../entities';
import { agreeTerms, effectiveMinStay } from '../common/domain';
import {
  calendarDayNumber,
  calendarDayToISO,
  todayDayNumber,
  todayDayNumberIST,
} from '../common/calendar-date.util';
import { NotificationsService } from '../notifications/notifications.service';
import { assertVerifiedContact } from '../common/contact-gate.util';
import { assertTransition, BookingStatus } from './booking-transitions';
import { cancellationRefund } from './cancellation-refund.util';
import { findConflicts } from '../listings/availability.util';
import { loadBufferDays, widenedWindow } from '../listings/buffer-days.util';
import { assertBookableCompat } from './booking-eligibility.compat';
import { bookingAmountsFromSnapshot, computePriceSnapshot, pricingFromPropertyDetails } from './offer-pricing.util';

export const ID_DISCLAIMER_VERSION = 'hp-id-v1';
/** Additive machine-readable `code` on date/open-request errors (message and status are unchanged). */
export const BOOKING_ERROR_CODES = {
  DATES_BUSY: 'DATES_BUSY',
  DATES_PAST: 'DATES_PAST',
  OPEN_REQUEST: 'OPEN_REQUEST',
  SELF_OVERLAP: 'SELF_OVERLAP',
} as const;
export type BookingErrorCode = (typeof BOOKING_ERROR_CODES)[keyof typeof BOOKING_ERROR_CODES];
const coded = (
  Ex: new (r: any) => HttpException,
  statusCode: number,
  error: string,
  message: string,
  code: BookingErrorCode,
) => new Ex({ statusCode, message, error, code });
const busyError = () =>
  coded(ConflictException, 409, 'Conflict', 'This property is not available for the selected dates.', BOOKING_ERROR_CODES.DATES_BUSY);
const pastError = (m: string) => coded(BadRequestException, 400, 'Bad Request', m, BOOKING_ERROR_CODES.DATES_PAST);
export const HOLD_TTL_MS = 48 * 60 * 60 * 1000;
/** After host approval the guest has this long to pay before the dates are released. */
export const PAY_BY_TTL_MS = 24 * 60 * 60 * 1000;
/** Statuses whose dates are taken. 'requested' deliberately does not block. */
export const BLOCKING_STATUSES = [
  'awaiting_payment',
  'confirmed',
  'approved',
  'checked_in',
  'disputed',
  'completed',
  'checked_out',
];
/** Request states a host can still act on (accept / decline / offer). */
export const HOST_PENDING_STATUSES = ['requested', 'host_review'];
/** Pre-payment states in which a guest already has an open booking with a host. */
export const OPEN_REQUEST_STATUSES = ['requested', 'host_review', 'offered'];
/**
 * Instant booking is intentionally NOT supported: every booking goes
 * request -> host offer -> guest accept -> payment. Do not add a code path that
 * moves a booking to awaiting_payment/confirmed without a host-created offer.
 */
export const INSTANT_BOOKING_ENABLED = false as const;
const PG_UNIQUE_VIOLATION = '23505';
const PG_EXCLUSION_VIOLATION = '23P01';
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

export function generateBookingReference(): string {
  let out = 'RB-';
  for (let i = 0; i < 6; i++) {
    out += REFERENCE_ALPHABET[randomInt(0, REFERENCE_ALPHABET.length)];
  }
  return out;
}

function pgCode(e: any): string | undefined {
  return e?.code ?? e?.driverError?.code;
}
function pgConstraint(e: any): string | undefined {
  return e?.constraint ?? e?.driverError?.constraint;
}
const STAY_CONFIRM_DELAY_MS = 24 * 60 * 60 * 1000;
import { CalendarSyncService } from '../calendar-sync/calendar-sync.service';
import { CashfreeService } from '../payments/cashfree.service';
import { PaymentsService } from '../payments/payments.service';
import { CommissionService } from '../finance/commission.service';
import { SupabaseProvider } from '../auth/supabase.provider';
import { CreateBookingDto } from './dto/create-booking.dto';
import { DisputeBookingDto } from './dto/dispute-booking.dto';
import {
  ReviewEntity,
  DisputeCaseEntity,
  DisputeEventEntity,
} from '../entities';

function splitResolution(payment: PaymentEntity | undefined | null) {
  if (
    !payment ||
    payment.status !== 'split' ||
    payment.split_amount_to_guest == null
  )
    return null;
  return {
    amountToGuest: payment.split_amount_to_guest,
    amountToHost: payment.amount - payment.split_amount_to_guest,
  };
}

type UploadedMulterFile = { buffer: Buffer; mimetype: string; size: number };

const EVIDENCE_ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;

/** Statuses a booking can still be cancelled from (before check-in). */
const CANCELLABLE_STATUSES = [
  'requested',
  'host_review',
  'offered',
  'awaiting_payment',
  'confirmed',
];
const NEGOTIATION_ROUNDS_CAP = 3;
const NEGOTIATION_STALE_HOURS = 48;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const CHECKIN_MAX_FAILED_ATTEMPTS = 5;
const CHECKIN_LOCKOUT_MS = 15 * 60 * 1000;

const ESCROW_HOLD_HOURS = 24;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toIndianMobile(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(local) ? local : null;
}

function generateCheckinCode(): string {
  return String(randomInt(0, 10000)).padStart(4, '0');
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function formatCalendarDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    @InjectRepository(BookingEntity)
    private readonly bookingsRepo: Repository<BookingEntity>,
    @InjectRepository(BookingEventEntity)
    private readonly bookingEventsRepo: Repository<BookingEventEntity>,
    @InjectRepository(ListingEntity)
    private readonly listingsRepo: Repository<ListingEntity>,
    @InjectRepository(UserEntity)
    private readonly profilesRepo: Repository<UserEntity>,
    @InjectRepository(ReviewEntity)
    private readonly reviewsRepo: Repository<ReviewEntity>,
    @InjectRepository(DisputeCaseEntity)
    private readonly disputeCasesRepo: Repository<DisputeCaseEntity>,
    @InjectRepository(DisputeEventEntity)
    private readonly disputeEventsRepo: Repository<DisputeEventEntity>,
    private readonly notifications: NotificationsService,
    private readonly payments: PaymentsService,
    private readonly supabase: SupabaseProvider,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly cashfree: CashfreeService,
    private readonly calendarSync: CalendarSyncService,
    @Optional() private readonly commission?: CommissionService,
  ) {}

  private async recordEvent(
    bookingId: string,
    fromStatus: string | null,
    toStatus: string,
    actor: string | null,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager
      ? manager.getRepository(BookingEventEntity)
      : this.bookingEventsRepo;
    await repo.insert({
      booking_id: bookingId,
      from_status: fromStatus,
      to_status: toStatus,
      actor,
    });
  }

  /**
   * The one place a booking's status changes. Validates the edge against the
   * transition matrix, applies a status-guarded UPDATE and records the audit
   * event on the SAME manager, so callers running inside a transaction commit
   * or roll back the change and its event together. Throws 409 if the row is
   * no longer in `from` (lost a race).
   */
  private async transition(
    manager: EntityManager,
    id: string,
    from: string,
    to: BookingStatus,
    actor: string | null,
    extra: Partial<BookingEntity> = {},
  ): Promise<void> {
    assertTransition(from, to);
    const res = await manager.update(
      BookingEntity,
      { id, status: from },
      { ...extra, status: to, updated_at: new Date() },
    );
    if (!res.affected) {
      throw new ConflictException('Booking status changed during operation');
    }
    await this.recordEvent(id, from, to, actor, manager);
  }

  /** Serialises create/approve per listing; released automatically at commit/rollback. */
  private async lockListing(manager: EntityManager, listingId: string) {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      listingId,
    ]);
  }

  private findOverlap(
    repo: Repository<BookingEntity>,
    listingId: string,
    moveIn: string,
    moveOut: string,
    excludeId?: string,
  ): Promise<BookingEntity | null> {
    const qb = repo
      .createQueryBuilder('b')
      .where('b.listing_id = :listingId', { listingId })
      .andWhere('b.status IN (:...statuses)', { statuses: BLOCKING_STATUSES })
      .andWhere('b.move_in < :moveOut', { moveOut })
      .andWhere('COALESCE(b.actual_move_out, b.move_out) > :moveIn', {
        moveIn,
      });
    if (excludeId) qb.andWhere('b.id <> :excludeId', { excludeId });
    return qb.getOne();
  }

  /**
   * Turnover-buffer check on top of findOverlap: other blocking bookings whose
   * range, widened by the listing's buffer_days, clashes with the stay.
   * buffer 0 (or no listing_pricing row) is a no-op, so behaviour is unchanged.
   */
  private async hasBufferConflict(
    repo: Repository<BookingEntity>,
    runner: { query: (sql: string, params?: any[]) => Promise<any> } | undefined,
    listingId: string,
    moveIn: string,
    moveOut: string,
    excludeId?: string,
  ): Promise<boolean> {
    const buffer = await loadBufferDays(runner, listingId);
    if (buffer <= 0) return false;
    const w = widenedWindow(moveIn, moveOut);
    const qb = repo
      .createQueryBuilder('b')
      .where('b.listing_id = :listingId', { listingId })
      .andWhere('b.status IN (:...statuses)', { statuses: BLOCKING_STATUSES })
      .andWhere('b.move_in < :we', { we: w.end })
      .andWhere('COALESCE(b.actual_move_out, b.move_out) > :ws', { ws: w.start });
    if (excludeId) qb.andWhere('b.id <> :excludeId', { excludeId });
    const rows = await qb.getMany();
    const occupied = rows.map((b) => ({ start: String(b.move_in), end: String(b.actual_move_out ?? b.move_out) }));
    return findConflicts(occupied, { start: moveIn, end: moveOut }, buffer).length > 0;
  }

  async create(
    userId: string,
    dto: CreateBookingDto,
    idempotencyKey?: string,
    opts?: { source?: 'inquiry' },
  ) {
    const key = idempotencyKey?.trim() || null;
    if (key) {
      if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        throw new BadRequestException('Idempotency-Key is too long.');
      }
      const replay = await this.findByIdempotencyKey(userId, key);
      if (replay) return replay;
    }

    const listing = await this.listingsRepo.findOne({
      where: { id: dto.listingId },
      select: {
        id: true,
        status: true,
        host_id: true,
        is_discovered: true,
        booking_eligible: true,
        draft_data: true,
      },
    });
    if (!listing || listing.is_discovered) {
      throw new NotFoundException('Listing not found');
    }
    if (listing.status !== 'live') {
      throw new BadRequestException(
        'This listing is not open for booking requests.',
      );
    }
    assertBookableCompat(listing);

    if (listing.host_id === userId) {
      throw new ForbiddenException('You cannot book your own property.');
    }

    if (dto.role === 'host') {
      throw new ForbiddenException(
        'You must switch to guest mode to book a property.',
      );
    }

    const guestAccount = await this.profilesRepo.findOne({
      where: { id: userId },
      select: { id: true, phone: true, email_verified_at: true, banned_at: true },
    });
    assertVerifiedContact(guestAccount);

    // Admin-initiated inquiry hand-off: the guest has not seen the checkbox; ID is still checked at check-in.
    const skipIdDisclaimer = opts?.source === 'inquiry';
    if (!skipIdDisclaimer && dto.idDisclaimerAccepted !== true) {
      throw new BadRequestException(
        'Please confirm you will show an original government ID at check-in.',
      );
    }

    const openHold = await this.bookingsRepo.findOne({
      where: { guest_id: userId, status: In(OPEN_REQUEST_STATUSES) },
      select: { id: true },
    });
    if (openHold) {
      throw coded(
        ConflictException,
        409,
        'Conflict',
        'You already have a pending request with a host. Wait for a reply or cancel it first.',
        BOOKING_ERROR_CODES.OPEN_REQUEST,
      );
    }

    const moveInDay = calendarDayNumber(dto.moveIn);
    const moveOutDay = calendarDayNumber(dto.moveOut);

    if (isNaN(moveInDay) || isNaN(moveOutDay)) {
      throw pastError('Invalid date format.');
    }
    if (moveInDay < todayDayNumber()) {
      throw pastError('Move-in date cannot be in the past.');
    }
    if (moveOutDay <= moveInDay) {
      throw pastError('Move-out date must be after move-in date.');
    }

    try {
      await this.calendarSync.assertDatesFree(dto.listingId, dto.moveIn, dto.moveOut);
    } catch (e) {
      if (e instanceof ConflictException) throw busyError();
      throw e;
    }

    const selfOverlapping = await this.bookingsRepo
      .createQueryBuilder('b')
      .where('b.listing_id = :listingId', { listingId: dto.listingId })
      .andWhere('b.guest_id = :userId', { userId })
      .andWhere('b.status IN (:...openStatuses)', { openStatuses: OPEN_REQUEST_STATUSES })
      .andWhere('b.move_in < :moveOut', { moveOut: dto.moveOut })
      .andWhere('b.move_out > :moveIn', { moveIn: dto.moveIn })
      .getOne();

    if (selfOverlapping) {
      throw coded(
        ConflictException,
        409,
        'Conflict',
        'You already have a pending request for this property for these dates.',
        BOOKING_ERROR_CODES.SELF_OVERLAP,
      );
    }

    const propertyDetails =
      (listing.draft_data as Record<string, any>)?.property_details ?? {};
    const listingTitle = propertyDetails.title ?? 'the listing';
    const dailyBaseRate =
      propertyDetails.dailyBaseRate ??
      Math.round(
        (propertyDetails.price || propertyDetails.monthlyRent || 12000) / 30,
      );

    if (typeof dailyBaseRate !== 'number' || isNaN(dailyBaseRate)) {
      throw new InternalServerErrorException(
        'Listing is missing pricing information',
      );
    }

    const weeklyDiscountPct = propertyDetails.weeklyDiscountPct ?? 15;
    const monthlyDiscountPct = propertyDetails.monthlyDiscountPct ?? 40;

    const adults = dto.adults ?? 1;
    const children = dto.children ?? 0;
    const infants = dto.infants ?? 0;
    const pets = dto.pets ?? 0;
    const partySize = adults + children;
    const maxGuests = propertyDetails.maxGuests;
    if (typeof maxGuests === 'number' && partySize > maxGuests) {
      throw new BadRequestException(
        `This property sleeps up to ${maxGuests} guest${maxGuests === 1 ? '' : 's'} — reduce your party size and try again.`,
      );
    }

    // Nights come from the dates, never from the client-supplied dto.days.
    const nights = moveOutDay - moveInDay;
    const minDays = effectiveMinStay(propertyDetails.minDays);
    if (nights < minDays) {
      throw new BadRequestException(
        `This property has a minimum stay of ${minDays} nights.`,
      );
    }

    const terms = agreeTerms(
      dailyBaseRate,
      weeklyDiscountPct,
      monthlyDiscountPct,
      nights,
      dto.paymentMethod,
    );

    // Rate comes from commission agreements (+ free-listing cap); the env
    // PLATFORM_COMMISSION_PERCENTAGE is only the documented fallback.
    const commissionRate = this.commission
      ? await this.commission.resolveRate(dto.listingId, listing.host_id)
      : {
          rateBps: Math.round(
            (this.config.get<number>('PLATFORM_COMMISSION_PERCENTAGE') ?? 0) *
              100,
          ),
          agreementId: null,
        };
    const grossBookingAmount = terms.totalRent;
    const platformCommission = Math.round(
      (grossBookingAmount * commissionRate.rateBps) / 10_000,
    );
    const hostPayoutAmount = grossBookingAmount - platformCommission;

    let bookingId: string | undefined;
    let reference = '';
    for (let attempt = 0; attempt < 5 && !bookingId; attempt++) {
      reference = generateBookingReference();
      try {
        bookingId = await this.dataSource.transaction(async (manager) => {
          // Overlap check and insert are one critical section per listing.
          await this.lockListing(manager, dto.listingId);
          const repo = manager.getRepository(BookingEntity);
          const overlapping = await this.findOverlap(
            repo,
            dto.listingId,
            dto.moveIn,
            dto.moveOut,
          );
          if (
            overlapping ||
            (await this.hasBufferConflict(repo, manager, dto.listingId, dto.moveIn, dto.moveOut))
          ) {
            throw busyError();
          }
          const inserted = await repo.insert({
            listing_id: dto.listingId,
            guest_id: userId,
            host_id: listing.host_id,
            status: 'requested',
            move_in: dto.moveIn,
            move_out: dto.moveOut,
            months: nights,
            adults,
            children,
            infants,
            pets,
            monthly_rent: terms.totalRent,
            deposit: terms.deposit,
            payment_method: terms.paymentMethod,
            due_at_move_in: terms.dueAtMoveIn,
            gross_booking_amount: grossBookingAmount,
            platform_commission: platformCommission,
            host_payout_amount: hostPayoutAmount,
            commission_rate_bps: commissionRate.rateBps,
            commission_agreement_id: commissionRate.agreementId,
            id_disclaimer_accepted_at: skipIdDisclaimer ? null : new Date(),
            id_disclaimer_version: skipIdDisclaimer ? null : ID_DISCLAIMER_VERSION,
            hold_expires_at: new Date(Date.now() + HOLD_TTL_MS),
            reference,
            idempotency_key: key,
          });
          const id = inserted.identifiers[0]?.id as string;
          if (!id) throw new InternalServerErrorException('Database error');
          await this.recordEvent(id, null, 'requested', userId, manager);
          return id;
        });
      } catch (e: any) {
        if (e instanceof HttpException) throw e;
        const code = pgCode(e);
        if (code === PG_EXCLUSION_VIOLATION) {
          throw busyError();
        }
        if (code === PG_UNIQUE_VIOLATION) {
          const constraint = pgConstraint(e) ?? '';
          if (key && constraint.includes('idempotency')) {
            const replay = await this.findByIdempotencyKey(userId, key);
            if (replay) return replay;
          }
          if (constraint.includes('reference')) continue; // retry a new reference
        }
        this.logger.error('[create] booking insert failed', e);
        throw new InternalServerErrorException(
          'Could not create the booking. Please try again.',
        );
      }
    }
    if (!bookingId) {
      throw new InternalServerErrorException(
        'Could not create the booking. Please try again.',
      );
    }

    const guestProfile = await this.profilesRepo.findOne({
      where: { id: userId },
      select: { full_name: true },
    });

    this.notifications.notify('booking.requested', listing.host_id, {
      listingTitle,
      guestName: guestProfile?.full_name ?? 'A guest',
      moveIn: dto.moveIn,
      pushTitle: `New booking request for ${listingTitle}`,
      pushBody: `${guestProfile?.full_name ?? 'A guest'} wants to stay from ${dto.moveIn}`,
      link: '/host?tab=bookings',
    });

    return {
      success: true,
      id: bookingId,
      status: 'requested' as const,
      reference,
    };
  }

  private async findByIdempotencyKey(userId: string, key: string) {
    const existing = await this.bookingsRepo.findOne({
      where: { guest_id: userId, idempotency_key: key },
      select: { id: true, status: true, reference: true },
    });
    if (!existing) return null;
    return {
      success: true,
      id: existing.id,
      status: existing.status as 'requested',
      reference: existing.reference,
      replayed: true as const,
    };
  }

  async list(
    userId: string,
    role: 'host' | 'guest',
    pagination: { page: number; pageSize: number },
  ) {
    const { page, pageSize } = pagination;
    const where = role === 'host' ? { host_id: userId } : { guest_id: userId };

    const [rows, total] = await this.bookingsRepo.findAndCount({
      where,
      order: { created_at: 'DESC' },
      take: pageSize,
      skip: (page - 1) * pageSize,
    });

    const listingIds = Array.from(new Set(rows.map((r) => r.listing_id)));
    const counterpartIds = Array.from(
      new Set(rows.map((r) => (role === 'host' ? r.guest_id : r.host_id))),
    );

    const [listingRows, profileRows, paymentsByBookingId, reviewsRows] =
      await Promise.all([
        listingIds.length
          ? this.listingsRepo.find({
              where: listingIds.map((id) => ({ id })),
              select: { id: true, draft_data: true },
            })
          : Promise.resolve([] as ListingEntity[]),
        counterpartIds.length
          ? this.profilesRepo.find({
              where: counterpartIds.map((id) => ({ id })),
              select: { id: true, full_name: true },
            })
          : Promise.resolve([] as UserEntity[]),
        this.payments.getForBookings(rows.map((row) => row.id)),
        this.reviewsRepo.find({
          where: { author_id: userId },
          select: { booking_id: true },
        }),
      ]);

    const titleById = new Map(
      listingRows.map((l) => [
        l.id,
        (l.draft_data as any)?.property_details?.title ?? 'Listing',
      ]),
    );
    const nameById = new Map(
      profileRows.map((p) => [p.id, p.full_name ?? 'RhenBasera user']),
    );
    const paidByBookingId = new Set(
      Array.from(paymentsByBookingId.values())
        .filter((p) =>
          (PaymentsService.PAID_STATUSES as readonly string[]).includes(
            p.status,
          ),
        )
        .map((p) => p.booking_id),
    );

    const bookings = rows.map((row) => ({
      id: row.id,
      listingId: row.listing_id,
      listingTitle: titleById.get(row.listing_id) ?? 'Listing',
      status: row.status,
      moveIn: row.move_in,
      moveOut: row.move_out,
      actualMoveOut: row.actual_move_out,
      resolution: splitResolution(paymentsByBookingId.get(row.id)),
      days: row.months,
      adults: row.adults,
      children: row.children,
      infants: row.infants,
      pets: row.pets,
      totalRent: row.monthly_rent,
      deposit: row.deposit,
      paymentMethod: row.payment_method as 'upi' | 'cash',
      dueAtMoveIn: row.due_at_move_in,
      grossBookingAmount: row.gross_booking_amount,
      platformCommission: row.platform_commission,
      hostPayoutAmount: row.host_payout_amount,
      checkinCode: role === 'host' ? row.checkin_code : null,
      checkinTime: row.checkin_time,
      hostIdCheckedAt: row.host_id_checked_at,
      hostIdCheckedDocType: row.host_id_checked_doc_type,
      escrowReleaseTime: row.escrow_release_time,
      rejectionReason: row.rejection_reason,
      isPaid: paidByBookingId.has(row.id),
      stayConfirmation: this.stayConfirmationState(row, userId),
      hasReviewed: reviewsRows
        ? reviewsRows.some((r) => r.booking_id === row.id)
        : false,
      counterpartName:
        nameById.get(role === 'host' ? row.guest_id : row.host_id) ??
        'RhenBasera user',
      createdAt: row.created_at,
    }));

    return { success: true, bookings, page, pageSize, total };
  }

  async getById(userId: string, id: string) {
    const row = await this.bookingsRepo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Booking not found');
    }
    if (row.guest_id !== userId && row.host_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }

    const [listing, hostProfile] = await Promise.all([
      this.listingsRepo.findOne({
        where: { id: row.listing_id },
        select: { draft_data: true },
      }),
      this.profilesRepo.findOne({
        where: { id: row.host_id },
        select: { full_name: true },
      }),
    ]);

    const payment = await this.payments.getForBooking(row.id);

    const booking = {
      id: row.id,
      listingId: row.listing_id,
      listingTitle:
        (listing?.draft_data as any)?.property_details?.title ?? 'Listing',
      hostName: hostProfile?.full_name ?? 'Host',
      status: row.status,
      moveIn: row.move_in,
      moveOut: row.move_out,
      actualMoveOut: row.actual_move_out,
      resolution: splitResolution(payment),
      days: row.months,
      adults: row.adults,
      children: row.children,
      infants: row.infants,
      pets: row.pets,
      totalRent: row.monthly_rent,
      deposit: row.deposit,
      paymentMethod: row.payment_method as 'upi' | 'cash',
      dueAtMoveIn: row.due_at_move_in,
      grossBookingAmount: row.gross_booking_amount,
      platformCommission: row.platform_commission,
      hostPayoutAmount: row.host_payout_amount,
      rejectionReason: row.rejection_reason,
      checkinCode: row.host_id === userId ? row.checkin_code : null,
      checkinTime: row.checkin_time,
      hostIdCheckedAt: row.host_id_checked_at,
      hostIdCheckedDocType: row.host_id_checked_doc_type,
      escrowReleaseTime: row.escrow_release_time,
      stayConfirmation: this.stayConfirmationState(row, userId),
      paymentStatus: payment?.status ?? null,
      reference: row.reference,
      payByAt: row.pay_by_at,
    };

    return { success: true, booking };
  }

  async approve(userId: string, id: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: {
        status: true,
        host_id: true,
        guest_id: true,
        listing_id: true,
        move_in: true,
        move_out: true,
        due_at_move_in: true,
        deposit: true,
        monthly_rent: true,
        months: true,
      },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.host_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    if (!HOST_PENDING_STATUSES.includes(booking.status)) {
      throw new ConflictException(
        `Cannot approve a booking in status "${booking.status}"`,
      );
    }
    const approveFrom = booking.status as BookingStatus;

    // A request does not block dates, so approving must prove the dates are
    // still free (another booking may have been confirmed since the request).
    const payByAt = new Date(Date.now() + this.payByTtlMs());
    try {
      await this.dataSource.transaction(async (manager) => {
        await this.lockListing(manager, booking.listing_id);
        const overlapping = await this.findOverlap(
          manager.getRepository(BookingEntity),
          booking.listing_id,
          booking.move_in,
          booking.move_out,
          id,
        );
        if (
          overlapping ||
          (await this.hasBufferConflict(
            manager.getRepository(BookingEntity),
            manager,
            booking.listing_id,
            booking.move_in,
            booking.move_out,
            id,
          ))
        ) {
          throw new ConflictException(
            'These dates are no longer available — another booking has been confirmed. Decline this request.',
          );
        }
        await this.transition(manager, id, approveFrom, 'confirmed', userId, {
          pay_by_at: payByAt,
        });
        // Legacy approve() = an implicit offer at the price computed at request
        // time, recorded as already accepted so every confirmed booking has one.
        await manager.getRepository(BookingOfferEntity).insert({
          booking_id: id,
          version: 1,
          price_snapshot: this.implicitSnapshot(booking),
          conditions: null,
          host_message: null,
          expires_at: payByAt,
          state: 'accepted',
          accepted_at: new Date(),
          created_by: userId,
        });
      });
    } catch (e) {
      if (pgCode(e) === PG_EXCLUSION_VIOLATION) {
        throw new ConflictException(
          'These dates are no longer available — another booking has been confirmed. Decline this request.',
        );
      }
      throw e;
    }

    const [listing, hostProfile] = await Promise.all([
      this.listingsRepo.findOne({
        where: { id: booking.listing_id },
        select: { draft_data: true },
      }),
      this.profilesRepo.findOne({
        where: { id: booking.host_id },
        select: { full_name: true },
      }),
    ]);

    const listingTitle =
      (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    const hostName = hostProfile?.full_name ?? 'Your host';

    this.notifications.notify('booking.confirmed', booking.guest_id, {
      listingTitle,
      hostName,
      moveIn: booking.move_in,
      pushTitle: 'Booking approved',
      pushBody: `${hostName} approved your request for ${listingTitle} — complete payment to secure it`,
      link: '/stays',
    });

    return { success: true, status: 'confirmed' as const };
  }

  /** Snapshot for the implicit offer created by the legacy approve() path. */
  private implicitSnapshot(
    b: Pick<BookingEntity, 'due_at_move_in' | 'deposit' | 'monthly_rent' | 'months'>,
  ) {
    return {
      currency: 'INR' as const,
      pricingMode: 'daily' as const,
      rate: b.months > 0 ? Math.round((b.monthly_rent ?? 0) / b.months) : 0,
      nights: b.months ?? 0,
      subtotal: b.monthly_rent ?? 0,
      deposit: b.deposit ?? 0,
      electricity: 0,
      cleaning: 0,
      extraGuest: 0,
      taxes: 0,
      computedTotal: b.due_at_move_in ?? 0,
      hostAdjustedTotal: b.due_at_move_in ?? 0,
      adjustmentPct: 0,
    };
  }

  private payByTtlMs(): number {
    const hours = Number(this.config?.get?.('BOOKING_PAY_BY_HOURS'));
    return Number.isFinite(hours) && hours > 0 ? hours * 3600_000 : PAY_BY_TTL_MS;
  }

  async decline(userId: string, id: string, reason: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: { status: true, host_id: true, guest_id: true, listing_id: true },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.host_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    if (!HOST_PENDING_STATUSES.includes(booking.status)) {
      throw new ConflictException(
        `Cannot decline a booking in status "${booking.status}"`,
      );
    }
    const declineFrom = booking.status as BookingStatus;

    await this.dataSource.transaction((manager) =>
      this.transition(manager, id, declineFrom, 'declined', userId, {
        rejection_reason: reason,
      }),
    );

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle =
      (listing?.draft_data as any)?.property_details?.title ?? 'the listing';

    this.notifications.notify('booking.declined', booking.guest_id, {
      listingTitle,
      pushTitle: 'Booking request declined',
      pushBody: `The host declined your request for ${listingTitle}`,
      link: '/stays',
    });

    return { success: true, status: 'declined' as const };
  }

  async cancel(userId: string, id: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: {
        status: true,
        host_id: true,
        guest_id: true,
        listing_id: true,
        move_in: true,
      },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.host_id !== userId && booking.guest_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    if (
      !CANCELLABLE_STATUSES.includes(booking.status)
    ) {
      throw new ConflictException(
        `Cannot cancel a booking in status "${booking.status}"`,
      );
    }

    const fromStatus = booking.status;

    // A guest may have paid at the gateway moments ago and we not yet know:
    // settle a pending order first so a held payment is refunded, not stranded.
    let payment = await this.payments.getForBooking(id);
    if (payment?.status === 'pending') {
      try {
        await this.syncPayment(id);
        payment = await this.payments.getForBooking(id);
      } catch (err) {
        this.logger.warn(
          `[cancel] could not sync pending payment for ${id}: ${(err as Error).message}`,
        );
      }
    }

    // Host cancellations always refund in full; a guest's refund follows the
    // listing's cancellation policy and how close check-in is.
    let guestShare: number | null = null; // null = full refund
    if (payment?.status === 'held' && userId === booking.guest_id) {
      const policyListing = await this.listingsRepo.findOne({
        where: { id: booking.listing_id },
        select: { draft_data: true },
      });
      const policy = (policyListing?.draft_data as any)?.property_details
        ?.cancellation;
      const calc = cancellationRefund(
        policy,
        booking.move_in,
        new Date(),
        payment.amount,
      );
      if (calc.refundAmount < payment.amount) guestShare = calc.refundAmount;
      this.logger.log(
        `[cancel] booking ${id} guest cancel, policy=${calc.policy} refund=${calc.refundAmount}/${payment.amount}`,
      );
    }

    await this.dataSource.transaction(async (manager) => {
      await this.transition(manager, id, fromStatus, 'cancelled', userId);
      await manager.update(
        BookingOfferEntity,
        { booking_id: id, state: 'pending' },
        { state: 'withdrawn' },
      );
      if (payment?.status === 'held') {
        // Status-guarded: if a release/dispute won the race this throws 409
        // and the cancellation above rolls back with it.
        if (guestShare === null) {
          await this.payments.refund(id, manager);
        } else {
          // Partial refund: payments.refund() is all-or-nothing today, so the
          // policy split goes through splitRelease (guest share / host share).
          await this.payments.splitRelease(id, guestShare, manager);
        }
      }
    });
    if (payment?.status === 'held') {
      this.logger.log(
        `[cancel] booking ${id} cancelled by ${userId}; held payment refunded`,
      );
    }
    // Close a still-pending Cashfree order so it cannot be paid late. If it
    // was paid in the meantime the reconcile job / onPaymentHeld refunds it.
    await Promise.resolve(this.payments.closePendingOrder?.(id)).catch((err) =>
      this.logger.warn(`[cancel] could not close order for ${id}: ${(err as Error).message}`),
    );

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle =
      (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    const otherParty =
      userId === booking.guest_id ? booking.host_id : booking.guest_id;

    this.notifications.notify('booking.cancelled', otherParty, {
      listingTitle,
      pushTitle: 'Booking cancelled',
      pushBody: `The booking for ${listingTitle} has been cancelled`,
      link: userId === booking.guest_id ? '/host?tab=bookings' : '/stays',
    });

    return { success: true, status: 'cancelled' as const };
  }

  /**
   * Admin-actor cancellation. Same matrix/refund machinery as cancel(), but the
   * admin picks the refund: 'full' (payments.refund), 'policy' (guest-cancel
   * tiers) or 'none' (host keeps it; needs a reason of 10+ chars). Checked-in,
   * checked-out, completed or disputed bookings are refused (409); disputes go
   * through resolveDispute.
   */
  async adminCancel(
    adminId: string,
    id: string,
    input: { reason: string; refundMode: 'full' | 'policy' | 'none' },
  ) {
    const reason = (input.reason ?? '').trim();
    if (!['full', 'policy', 'none'].includes(input.refundMode)) {
      throw new BadRequestException('refundMode must be full, policy or none');
    }
    if (reason.length < (input.refundMode === 'none' ? 10 : 5) || reason.length > 1000) {
      throw new BadRequestException(
        input.refundMode === 'none'
          ? 'A reason of at least 10 characters is required when no refund is given'
          : 'A reason of at least 5 characters is required',
      );
    }
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: { status: true, host_id: true, guest_id: true, listing_id: true, move_in: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (!CANCELLABLE_STATUSES.includes(booking.status)) {
      const why = ['checked_in', 'checked_out', 'completed', 'disputed'].includes(booking.status)
        ? `A booking in status "${booking.status}" cannot be cancelled by an admin; a disputed booking must be resolved through the dispute flow.`
        : `Cannot cancel a booking in status "${booking.status}"`;
      throw new ConflictException(why);
    }
    const fromStatus = booking.status;

    let payment = await this.payments.getForBooking(id);
    if (payment?.status === 'pending') {
      try {
        await this.syncPayment(id);
        payment = await this.payments.getForBooking(id);
      } catch (err) {
        this.logger.warn(`[adminCancel] could not sync pending payment for ${id}: ${(err as Error).message}`);
      }
    }

    // guestShare: null = full refund, otherwise rupees to the guest (0 = none).
    let guestShare: number | null = null;
    if (payment?.status === 'held') {
      if (input.refundMode === 'none') guestShare = 0;
      else if (input.refundMode === 'policy') {
        const l = await this.listingsRepo.findOne({ where: { id: booking.listing_id }, select: { draft_data: true } });
        const calc = cancellationRefund(
          (l?.draft_data as any)?.property_details?.cancellation,
          booking.move_in,
          new Date(),
          payment.amount,
        );
        if (calc.refundAmount < payment.amount) guestShare = calc.refundAmount;
      }
    }

    await this.dataSource.transaction(async (manager) => {
      await this.transition(manager, id, fromStatus, 'cancelled', adminId);
      await manager.update(BookingOfferEntity, { booking_id: id, state: 'pending' }, { state: 'withdrawn' });
      if (payment?.status === 'held') {
        if (guestShare === null) await this.payments.refund(id, manager);
        else await this.payments.splitRelease(id, guestShare, manager);
      }
    });
    this.logger.log(
      `[adminCancel] booking ${id} cancelled by admin ${adminId} mode=${input.refundMode} from=${fromStatus} reason="${reason.slice(0, 200)}"`,
    );
    await Promise.resolve(this.payments.closePendingOrder?.(id)).catch((err) =>
      this.logger.warn(`[adminCancel] could not close order for ${id}: ${(err as Error).message}`),
    );

    const listing = await this.listingsRepo.findOne({ where: { id: booking.listing_id }, select: { draft_data: true } });
    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    const payload = {
      listingTitle,
      pushTitle: 'Booking cancelled',
      pushBody: `The booking for ${listingTitle} was cancelled by RhenBasera support`,
    };
    this.notifications.notify('booking.cancelled', booking.guest_id, { ...payload, link: '/stays' }, { dedupeKey: `admin-cancel:${id}` });
    this.notifications.notify('booking.cancelled', booking.host_id, { ...payload, link: '/host?tab=bookings' }, { dedupeKey: `admin-cancel:${id}` });

    return {
      success: true,
      status: 'cancelled' as const,
      refundMode: input.refundMode,
      refundedToGuest: payment?.status === 'held' ? (guestShare === null ? payment.amount : guestShare) : 0,
    };
  }

  async pay(userId: string, id: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: {
        status: true,
        guest_id: true,
        host_id: true,
        listing_id: true,
        move_in: true,
        move_out: true,
        pay_by_at: true,
        due_at_move_in: true,
        host_payout_amount: true,
        platform_commission: true,
      },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.guest_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    // awaiting_payment = guest accepted an offer; confirmed = legacy approve() (unpaid) .
    if (booking.status !== 'confirmed' && booking.status !== 'awaiting_payment') {
      throw new ConflictException(
        `Cannot pay for a booking in status "${booking.status}"`,
      );
    }
    if (booking.pay_by_at && booking.pay_by_at.getTime() < Date.now()) {
      throw new ConflictException(
        'The payment window for this booking has passed. Please send a new request.',
      );
    }
    const clash = await this.findOverlap(
      this.bookingsRepo,
      booking.listing_id,
      booking.move_in,
      booking.move_out,
      id,
    );
    if (
      clash ||
      (await this.hasBufferConflict(this.bookingsRepo, this.dataSource, booking.listing_id, booking.move_in, booking.move_out, id))
    ) {
      throw new ConflictException(
        'This property is no longer available for the selected dates.',
      );
    }

    const existing = await this.payments.getForBooking(id);
    if (
      existing &&
      existing.status !== 'pending' &&
      existing.status !== 'failed'
    ) {
      throw new ConflictException('This booking has already been paid for.');
    }

    let attempt = 1;
    if (existing) {
      const order = await this.cashfree.fetchPgOrder(
        existing.cashfree_order_id,
      );
      if (order?.status === 'PAID') {
        await this.syncPayment(id);
        return {
          success: true,
          status: 'confirmed' as const,
          paid: true as const,
        };
      }
      if (
        existing.status === 'pending' &&
        order?.status === 'ACTIVE' &&
        order.paymentSessionId
      ) {
        return this.checkoutPayload(order.orderId, order.paymentSessionId);
      }
      attempt = existing.attempt + 1;
    }

    const guest = await this.profilesRepo.findOne({
      where: { id: userId },
      select: { phone: true, email: true },
    });
    const phone = toIndianMobile(guest?.phone);
    if (!phone) {
      throw new BadRequestException(
        'Add a mobile number to your profile before paying.',
      );
    }

    const orderId = `bk_${id.replace(/-/g, '')}_${attempt}`;
    const order = await this.cashfree.createPgOrder({
      orderId,
      amount: booking.due_at_move_in,
      customerId: userId,
      customerPhone: phone,
      ...(guest?.email && EMAIL_SHAPE.test(guest.email)
        ? { customerEmail: guest.email }
        : {}),
      returnUrl: `${this.appUrl()}/booking/confirmed?booking=${id}&order_id={order_id}`,
      notifyUrl: this.webhookUrl(),
    });
    if (!order.paymentSessionId) {
      throw new InternalServerErrorException(
        'Payment service returned no checkout session',
      );
    }

    if (existing) {
      await this.payments.replaceOrder(id, orderId, attempt);
    } else {
      await this.payments.createPending(id, booking.due_at_move_in, orderId, {
        hostId: booking.host_id,
        hostPayoutAmount: booking.host_payout_amount,
        platformCommission: booking.platform_commission,
      });
    }
    return this.checkoutPayload(order.orderId, order.paymentSessionId);
  }

  private checkoutPayload(orderId: string, paymentSessionId: string) {
    return {
      success: true,
      status: 'confirmed' as const,
      paid: false as const,
      orderId,
      paymentSessionId,
      checkoutMode: this.cashfree.checkoutMode,
    };
  }

  private appUrl(): string {
    return (this.config.get<string>('APP_URL') ?? '').replace(/\/+$/, '');
  }

  private webhookUrl(): string | undefined {
    const base = this.appUrl();
    if (!base.startsWith('https://') || /localhost|127\.0\.0\.1/.test(base))
      return undefined;
    return `${base}/api/payments/cashfree/webhook`;
  }

  async syncPayment(
    bookingId: string,
  ): Promise<'held' | 'pending' | 'failed' | 'none'> {
    const payment = await this.payments.getForBooking(bookingId);
    if (!payment) return 'none';
    if (payment.status === 'failed') return 'failed';
    if (payment.status !== 'pending') return 'held';

    const order = await this.cashfree.fetchPgOrder(payment.cashfree_order_id);
    if (!order) return 'pending';

    if (order.status === 'PAID') {
      if (order.amount !== payment.amount || order.currency !== 'INR') {
        this.logger.error(
          `Cashfree order ${order.orderId} is PAID for ${order.amount} ${order.currency} but booking ${bookingId} expects ${payment.amount} INR — not confirming`,
        );
        return 'pending';
      }
      const cfPaymentId = await this.cashfree.fetchSuccessfulPaymentId(
        order.orderId,
      );
      if (await this.payments.markHeld(bookingId, cfPaymentId)) {
        await this.onPaymentHeld(bookingId);
      }
      return 'held';
    }
    if (
      order.status === 'EXPIRED' ||
      order.status === 'TERMINATED' ||
      order.status === 'TERMINATION_REQUESTED'
    ) {
      await this.payments.markFailed(bookingId);
      return 'failed';
    }
    return 'pending';
  }

  async getPaymentStatus(userId: string, id: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: { guest_id: true, host_id: true },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.guest_id !== userId && booking.host_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    return { success: true, paymentStatus: await this.syncPayment(id) };
  }

  private async onPaymentHeld(bookingId: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id: bookingId },
      select: {
        status: true,
        guest_id: true,
        host_id: true,
        listing_id: true,
        due_at_move_in: true,
        move_in: true,
        move_out: true,
      },
    });
    if (!booking) return;
    if (booking.status === 'awaiting_payment') {
      // Verified payment on an accepted offer: awaiting_payment -> confirmed.
      try {
        await this.dataSource.transaction((manager) =>
          this.transition(manager, bookingId, 'awaiting_payment', 'confirmed', null),
        );
        booking.status = 'confirmed';
      } catch (err) {
        if (!(err instanceof ConflictException)) throw err;
        const fresh = await this.bookingsRepo.findOne({
          where: { id: bookingId },
          select: { status: true },
        });
        booking.status = fresh?.status ?? booking.status;
      }
    }
    if (booking.status !== 'confirmed') {
      // Late payment on a cancelled/expired/declined booking: give it back.
      // (Gateway-side refund is still simulated like payouts, so also log it.)
      try {
        await this.payments.refund(bookingId);
        this.logger.error(
          `Booking ${bookingId} was paid while in status "${booking.status}" — payment auto-refunded in the ledger; issue the gateway refund`,
        );
      } catch (err) {
        this.logger.error(
          `Booking ${bookingId} was paid while in status "${booking.status}" and the auto-refund failed — needs a manual refund: ${(err as Error).message}`,
        );
      }
      return;
    }

    await this.bookingsRepo.update(
      { id: bookingId, status: 'confirmed' },
      { checkin_code: generateCheckinCode(), updated_at: new Date() },
    );

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle =
      (listing?.draft_data as any)?.property_details?.title ?? 'the listing';

    this.notifications.notify('booking.payment_held', booking.host_id, {
      listingTitle,
      pushTitle: 'Payment received and held',
      pushBody: `Payment for ${listingTitle} is held — your guest is on their way`,
      link: '/host?tab=bookings',
    });

    this.notifications.notify('booking.payment_receipt', booking.guest_id, {
      listingTitle,
      moveIn: booking.move_in,
      moveOut: booking.move_out,
      amount: booking.due_at_move_in,
      pushTitle: 'Payment received',
      pushBody: `Your payment for ${listingTitle} is held by RhenBasera until 24 hours after check-in`,
      link: '/settings?tab=bookings',
    });

    this.notifications.notify('booking.checkin_code_ready', booking.host_id, {
      listingTitle,
      pushTitle: 'Check-in code ready',
      pushBody: `Your guest's check-in code for ${listingTitle} is ready — give it to them in person on arrival`,
      link: '/host?tab=bookings',
    });
  }

  async hostIdCheck(userId: string, id: string, docType: string | null) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: {
        status: true,
        guest_id: true,
        host_id: true,
        listing_id: true,
        host_id_checked_at: true,
        host_id_checked_doc_type: true,
      },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.host_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    if (booking.host_id_checked_at) {
      return {
        success: true,
        hostIdCheckedAt: booking.host_id_checked_at,
        hostIdCheckedDocType: booking.host_id_checked_doc_type,
      };
    }
    if (booking.status !== 'confirmed') {
      throw new ConflictException(
        `Cannot record an ID check for a booking in status "${booking.status}"`,
      );
    }
    const payment = await this.payments.getForBooking(id);
    if (!payment || payment.status !== 'held') {
      throw new ConflictException('Payment must be completed first.');
    }
    const now = new Date();
    const updateRes = await this.bookingsRepo.update(
      { id, status: 'confirmed', host_id_checked_at: IsNull() },
      {
        host_id_checked_at: now,
        host_id_checked_doc_type: docType,
        updated_at: now,
      },
    );
    if (updateRes.affected === 0) {
      return this.hostIdCheck(userId, id, docType);
    }
    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle =
      (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    this.notifications.notify('booking.host_id_checked', booking.guest_id, {
      listingTitle,
      pushTitle: 'Your host checked your ID',
      pushBody: `Your host says they checked your ID in person for ${listingTitle}`,
      link: '/settings?tab=bookings',
    });
    return {
      success: true,
      hostIdCheckedAt: now,
      hostIdCheckedDocType: docType,
    };
  }

  private async getCheckinLockout(bookingId: string): Promise<Date | null> {
    const rows: { locked_until: Date | string | null }[] =
      await this.dataSource.query(
        'SELECT locked_until FROM check_in_lockouts WHERE booking_id = $1',
        [bookingId],
      );
    const raw = rows?.[0]?.locked_until;
    return raw ? new Date(raw) : null;
  }

  /** Atomic across instances: one UPSERT increments the counter and sets the lock. */
  private async recordCheckinFailure(bookingId: string): Promise<void> {
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + CHECKIN_LOCKOUT_MS);
    await this.dataSource.query(
      `INSERT INTO check_in_lockouts (booking_id, failed_count, locked_until, updated_at)
       VALUES ($1, 1, CASE WHEN 1 >= $3::int THEN $4::timestamptz ELSE NULL END, $2::timestamptz)
       ON CONFLICT (booking_id) DO UPDATE SET
         failed_count = CASE
           WHEN check_in_lockouts.locked_until IS NOT NULL AND check_in_lockouts.locked_until <= $2::timestamptz
             THEN 1 ELSE check_in_lockouts.failed_count + 1 END,
         locked_until = CASE
           WHEN (CASE
                   WHEN check_in_lockouts.locked_until IS NOT NULL AND check_in_lockouts.locked_until <= $2::timestamptz
                     THEN 1 ELSE check_in_lockouts.failed_count + 1 END)   >= $3::int
             THEN $4::timestamptz ELSE NULL END,
         updated_at = $2::timestamptz`,
      [bookingId, now, CHECKIN_MAX_FAILED_ATTEMPTS, lockedUntil],
    );
  }

  private async clearCheckinLockout(bookingId: string): Promise<void> {
    await this.dataSource.query(
      'DELETE FROM check_in_lockouts WHERE booking_id = $1',
      [bookingId],
    );
  }

  async checkin(userId: string, id: string, code: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: {
        status: true,
        guest_id: true,
        host_id: true,
        listing_id: true,
        checkin_code: true,
        move_in: true,
        move_out: true,
      },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.guest_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    if (booking.status !== 'confirmed') {
      throw new ConflictException(
        `Cannot check in a booking in status "${booking.status}"`,
      );
    }
    const payment = await this.payments.getForBooking(id);
    if (!payment || payment.status !== 'held') {
      throw new ConflictException('Payment must be completed before check-in.');
    }
    const today = todayDayNumberIST();
    if (today < calendarDayNumber(booking.move_in)) {
      throw new BadRequestException(
        `Check-in opens on ${formatCalendarDate(booking.move_in)}.`,
      );
    }
    if (today > calendarDayNumber(booking.move_out)) {
      throw new BadRequestException(
        `Check-in is closed — this stay ended on ${formatCalendarDate(booking.move_out)}.`,
      );
    }
    const lock = await this.getCheckinLockout(id);
    if (lock && lock.getTime() > Date.now()) {
      const retryAfterSeconds = Math.ceil((lock.getTime() - Date.now()) / 1000);
      const minutes = Math.ceil(retryAfterSeconds / 60);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const expected = booking.checkin_code
      ? Buffer.from(booking.checkin_code)
      : null;
    const given = Buffer.from(code);
    if (
      !expected ||
      expected.length !== given.length ||
      !timingSafeEqual(expected, given)
    ) {
      await this.recordCheckinFailure(id);
      throw new BadRequestException('That check-in code is incorrect.');
    }
    await this.clearCheckinLockout(id);

    const now = new Date();
    const escrowReleaseTime = new Date(
      now.getTime() + ESCROW_HOLD_HOURS * 60 * 60 * 1000,
    );

    await this.dataSource.transaction((manager) =>
      this.transition(manager, id, 'confirmed', 'checked_in', userId, {
        checkin_time: now,
        escrow_release_time: escrowReleaseTime,
      }),
    );

    const [listing, guestProfile] = await Promise.all([
      this.listingsRepo.findOne({
        where: { id: booking.listing_id },
        select: { draft_data: true },
      }),
      this.profilesRepo.findOne({
        where: { id: booking.guest_id },
        select: { full_name: true },
      }),
    ]);
    const listingTitle =
      (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    const guestName = guestProfile?.full_name ?? 'Your guest';

    this.notifications.notify('booking.checked_in', booking.host_id, {
      listingTitle,
      guestName,
      pushTitle: 'Guest checked in',
      pushBody: `${guestName} checked in at ${listingTitle} — payout in 24h unless disputed`,
      link: '/host?tab=bookings',
    });

    this.notifications.notify('booking.checkin_confirmed', booking.guest_id, {
      listingTitle,
      checkinTime: now.toISOString(),
      escrowReleaseTime: escrowReleaseTime.toISOString(),
      pushTitle: 'Check-in confirmed',
      pushBody: `You are checked in at ${listingTitle}`,
      link: '/settings?tab=bookings',
    });

    return { success: true, status: 'checked_in' as const, escrowReleaseTime };
  }

  async dispute(userId: string, id: string, dto: DisputeBookingDto) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: {
        status: true,
        guest_id: true,
        host_id: true,
        listing_id: true,
        escrow_release_time: true,
        move_out: true,
      },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.guest_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    if (booking.status !== 'checked_in') {
      throw new ConflictException(
        `Cannot dispute a booking in status "${booking.status}"`,
      );
    }
    if (dto.category === 'early_departure') {
      const leavingDay = calendarDayNumber(dto.leavingOn ?? '');
      if (isNaN(leavingDay)) {
        throw new BadRequestException('Choose the date you are leaving.');
      }
      if (leavingDay < todayDayNumberIST()) {
        throw new BadRequestException('Leaving date cannot be in the past.');
      }
      if (leavingDay >= calendarDayNumber(booking.move_out)) {
        throw new BadRequestException(
          'Leaving date must be before the move-out date.',
        );
      }
    }
    if (
      booking.escrow_release_time &&
      booking.escrow_release_time.getTime() <= Date.now()
    ) {
      throw new ConflictException(
        'The dispute window for this booking has closed.',
      );
    }

    const payment = await this.payments.getForBooking(id);
    const requestedAmount = dto.requestedAmount ?? 0;
    if (payment && requestedAmount > payment.amount) {
      throw new BadRequestException(
        'Requested amount cannot exceed the amount paid.',
      );
    }

    const disputeCase = await this.dataSource.transaction(async (manager) => {
      await this.transition(manager, id, 'checked_in', 'disputed', userId);

      const disputeCasesRepo = manager.getRepository(DisputeCaseEntity);
      const savedCase = await disputeCasesRepo.save(
        disputeCasesRepo.create({
          booking_id: id,
          category: dto.category,
          description: dto.description,
          requested_amount: requestedAmount,
          leaving_on: dto.category === 'early_departure' ? dto.leavingOn : null,
          evidence_urls: [],
          case_status: 'open',
        }),
      );
      await manager.getRepository(DisputeEventEntity).insert({
        dispute_case_id: savedCase.id,
        actor_id: userId,
        actor_role: 'guest',
        event_type: 'claim_raised',
        offer_amount: dto.requestedAmount ?? null,
        message: dto.description,
      });

      return savedCase;
    });

    const [listing, guestProfile] = await Promise.all([
      this.listingsRepo.findOne({
        where: { id: booking.listing_id },
        select: { draft_data: true },
      }),
      this.profilesRepo.findOne({
        where: { id: booking.guest_id },
        select: { full_name: true },
      }),
    ]);
    const listingTitle =
      (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    const guestName = guestProfile?.full_name ?? 'Your guest';

    this.notifications.notify('booking.disputed', booking.host_id, {
      listingTitle,
      guestName,
      pushTitle: 'Dispute raised',
      pushBody: `${guestName} raised a dispute for ${listingTitle} — RhenBasera is reviewing`,
      link: '/host?tab=bookings',
    });
    this.notifications.notify('dispute.raised_confirmation', booking.guest_id, {
      listingTitle,
      link: '/settings?tab=bookings',
    });

    return {
      success: true,
      status: 'disputed' as const,
      disputeCaseId: disputeCase.id,
    };
  }

  private async requireDisputeCase(userId: string, bookingId: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id: bookingId },
      select: {
        guest_id: true,
        host_id: true,
        listing_id: true,
        move_in: true,
        move_out: true,
      },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.guest_id !== userId && booking.host_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    const disputeCase = await this.disputeCasesRepo.findOne({
      where: { booking_id: bookingId },
    });
    if (!disputeCase) {
      throw new NotFoundException('No dispute found for this booking');
    }
    return {
      booking,
      disputeCase,
      viewerRole: (booking.guest_id === userId ? 'guest' : 'host') as
        'guest' | 'host',
    };
  }

  async getDisputeCase(userId: string, bookingId: string) {
    const { disputeCase, viewerRole } = await this.requireDisputeCase(
      userId,
      bookingId,
    );
    return {
      success: true,
      viewerRole,
      ...(await this.loadDisputeTimeline(disputeCase)),
    };
  }

  async getDisputeCaseForAdmin(bookingId: string) {
    const disputeCase = await this.disputeCasesRepo.findOne({
      where: { booking_id: bookingId },
    });
    if (!disputeCase) {
      throw new NotFoundException('No dispute found for this booking');
    }
    return {
      success: true,
      viewerRole: 'admin' as const,
      ...(await this.loadDisputeTimeline(disputeCase)),
    };
  }

  private async loadDisputeTimeline(disputeCase: DisputeCaseEntity) {
    const events = await this.disputeEventsRepo.find({
      where: { dispute_case_id: disputeCase.id },
      order: { created_at: 'ASC' },
    });
    const clockStart =
      disputeCase.case_status === 'open'
        ? disputeCase.created_at
        : disputeCase.case_status === 'negotiating'
          ? disputeCase.updated_at
          : null;
    const responseDeadline = clockStart
      ? new Date(
          new Date(clockStart).getTime() +
            NEGOTIATION_STALE_HOURS * 60 * 60 * 1000,
        ).toISOString()
      : null;
    return { case: disputeCase, events, responseDeadline };
  }

  async addDisputeEvidence(
    userId: string,
    bookingId: string,
    files: UploadedMulterFile[],
  ) {
    const { disputeCase } = await this.requireDisputeCase(userId, bookingId);
    if (files.length === 0) {
      throw new BadRequestException('No files provided');
    }
    if (disputeCase.evidence_urls.length + files.length > 6) {
      throw new BadRequestException(
        'A dispute may have at most 6 evidence files.',
      );
    }

    const urls: string[] = [];
    for (const file of files) {
      const ext = EVIDENCE_ALLOWED_TYPES[file.mimetype];
      if (!ext) {
        throw new BadRequestException(
          'Unsupported file type. Use JPEG, PNG or WebP.',
        );
      }
      if (file.size > EVIDENCE_MAX_BYTES) {
        throw new PayloadTooLargeException(
          'File too large. Maximum size is 5 MB.',
        );
      }

      const storagePath = `${bookingId}/${randomUUID()}.${ext}`;
      const { error: uploadError } = await this.supabase.client.storage
        .from('dispute-evidence')
        .upload(storagePath, file.buffer, { contentType: file.mimetype });
      if (uploadError) {
        throw new InternalServerErrorException(
          'Upload failed. Please try again.',
        );
      }

      const {
        data: { publicUrl },
      } = this.supabase.client.storage
        .from('dispute-evidence')
        .getPublicUrl(storagePath);
      urls.push(publicUrl);
    }

    await this.disputeCasesRepo.update(
      { id: disputeCase.id },
      {
        evidence_urls: [...disputeCase.evidence_urls, ...urls],
        updated_at: new Date(),
      },
    );
    return { success: true, evidenceUrls: urls };
  }

  async makeDisputeOffer(
    userId: string,
    bookingId: string,
    amountToGuest: number,
    message: string | undefined,
  ) {
    const { booking, disputeCase, viewerRole } = await this.requireDisputeCase(
      userId,
      bookingId,
    );
    if (
      disputeCase.case_status !== 'open' &&
      disputeCase.case_status !== 'negotiating'
    ) {
      throw new ConflictException(
        `Cannot make an offer on a case in status "${disputeCase.case_status}"`,
      );
    }

    const payment = await this.payments.getForBooking(bookingId);
    if (payment && (amountToGuest < 0 || amountToGuest > payment.amount)) {
      throw new BadRequestException(
        'amountToGuest must be between 0 and the amount paid.',
      );
    }
    if (disputeCase.negotiation_rounds >= NEGOTIATION_ROUNDS_CAP) {
      throw new ConflictException(
        'Negotiation rounds are exhausted — escalate to RhenBasera instead.',
      );
    }

    const lastEvent = await this.disputeEventsRepo.findOne({
      where: { dispute_case_id: disputeCase.id },
      order: { created_at: 'DESC' },
    });
    const lastOfferRole =
      lastEvent?.event_type === 'claim_raised'
        ? null
        : (lastEvent?.actor_role ?? null);
    if (lastOfferRole === viewerRole) {
      throw new ConflictException(
        'Waiting on the other party — not your turn to offer.',
      );
    }
    if (viewerRole === 'guest' && lastOfferRole === null) {
      throw new ForbiddenException('Only the host can make the first offer.');
    }

    const eventType =
      viewerRole === 'host'
        ? lastOfferRole === null
          ? 'host_offer'
          : 'host_counter'
        : 'guest_counter';

    await this.disputeEventsRepo.insert({
      dispute_case_id: disputeCase.id,
      actor_id: userId,
      actor_role: viewerRole,
      event_type: eventType,
      offer_amount: amountToGuest,
      message: message ?? null,
    });
    await this.disputeCasesRepo.update(
      { id: disputeCase.id },
      {
        case_status: 'negotiating',
        negotiation_rounds: disputeCase.negotiation_rounds + 1,
        updated_at: new Date(),
      },
    );

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle =
      (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    const recipient =
      viewerRole === 'host' ? booking.guest_id : booking.host_id;
    this.notifications.notify('dispute.offer_received', recipient, {
      listingTitle,
      offerAmount: amountToGuest,
      link:
        viewerRole === 'host' ? '/settings?tab=bookings' : '/host?tab=bookings',
    });

    return { success: true, caseStatus: 'negotiating' as const };
  }

  async respondToDisputeOffer(
    userId: string,
    bookingId: string,
    action: 'accept' | 'reject' | 'escalate',
  ) {
    const { booking, disputeCase, viewerRole } = await this.requireDisputeCase(
      userId,
      bookingId,
    );
    if (
      disputeCase.case_status !== 'negotiating' &&
      !(action === 'escalate' && disputeCase.case_status === 'open')
    ) {
      throw new ConflictException(
        `Cannot respond to a case in status "${disputeCase.case_status}"`,
      );
    }

    if (action === 'accept') {
      const lastOffer = await this.disputeEventsRepo.findOne({
        where: { dispute_case_id: disputeCase.id },
        order: { created_at: 'DESC' },
      });
      if (
        !lastOffer ||
        lastOffer.offer_amount === null ||
        lastOffer.actor_role === viewerRole
      ) {
        throw new ConflictException('No standing offer to accept.');
      }

      const acceptedAmount = lastOffer.offer_amount;
      await this.dataSource.transaction(async (manager) => {
        await this.transition(
          manager,
          bookingId,
          'disputed',
          'completed',
          userId,
          {
            actual_move_out: this.resolvedStayEnd(
              booking.move_in,
              booking.move_out,
              disputeCase,
            ),
          },
        );
        await this.payments.splitRelease(bookingId, acceptedAmount, manager);
        await manager.getRepository(DisputeEventEntity).insert({
          dispute_case_id: disputeCase.id,
          actor_id: userId,
          actor_role: viewerRole,
          event_type: 'accepted',
          offer_amount: acceptedAmount,
        });
        await manager.update(
          DisputeCaseEntity,
          { id: disputeCase.id },
          {
            case_status: 'resolved',
            resolution_amount_to_guest: acceptedAmount,
            resolved_by: 'negotiation',
            updated_at: new Date(),
          },
        );
      });

      const listing = await this.listingsRepo.findOne({
        where: { id: booking.listing_id },
        select: { draft_data: true },
      });
      const listingTitle =
        (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
      const otherParty =
        viewerRole === 'guest' ? booking.host_id : booking.guest_id;
      const amounts = await this.disputeAmounts(
        bookingId,
        lastOffer.offer_amount,
      );
      const linkFor = (role: 'guest' | 'host') =>
        role === 'host' ? '/host?tab=bookings' : '/settings?tab=bookings';
      this.notifications.notify('dispute.offer_accepted', otherParty, {
        listingTitle,
        ...amounts,
        decidedBy: 'negotiation',
        link: linkFor(viewerRole === 'guest' ? 'host' : 'guest'),
      });
      this.notifications.notify('dispute.resolved', userId, {
        listingTitle,
        ...amounts,
        decidedBy: 'negotiation',
        link: linkFor(viewerRole),
      });

      return { success: true, caseStatus: 'resolved' as const };
    }

    await this.disputeEventsRepo.insert({
      dispute_case_id: disputeCase.id,
      actor_id: userId,
      actor_role: viewerRole,
      event_type: action === 'reject' ? 'rejected' : 'escalated',
    });
    await this.disputeCasesRepo.update(
      { id: disputeCase.id },
      { case_status: 'escalated', updated_at: new Date() },
    );

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle =
      (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    if (action === 'reject') {
      this.notifications.notify(
        'dispute.offer_rejected',
        booking.guest_id === userId ? booking.host_id : booking.guest_id,
        {
          listingTitle,
          link:
            viewerRole === 'guest'
              ? '/host?tab=bookings'
              : '/settings?tab=bookings',
        },
      );
    }
    this.notifyDisputeEscalated(booking, listingTitle);

    return { success: true, caseStatus: 'escalated' as const };
  }

  private notifyDisputeEscalated(
    booking: { guest_id: string; host_id: string },
    listingTitle: string,
  ): void {
    this.notifications.notify('dispute.escalated', booking.guest_id, {
      listingTitle,
      link: '/settings?tab=bookings',
    });
    this.notifications.notify('dispute.escalated', booking.host_id, {
      listingTitle,
      link: '/host?tab=bookings',
    });
  }

  private async disputeAmounts(bookingId: string, amountToGuest: number) {
    let payment: Awaited<ReturnType<PaymentsService['getForBooking']>> = null;
    try {
      payment = await this.payments.getForBooking(bookingId);
    } catch (err) {
      this.logger.warn(
        `[disputeAmounts] payment lookup failed for booking ${bookingId}: ${String(err)}`,
      );
    }
    return {
      amountToGuest,
      amountToHost: payment
        ? Math.max(0, payment.amount - amountToGuest)
        : undefined,
    };
  }

  async escalateStaleNegotiations(): Promise<number> {
    const staleBefore = new Date(
      Date.now() - NEGOTIATION_STALE_HOURS * 60 * 60 * 1000,
    );
    const stale = await this.disputeCasesRepo.find({
      where: [{ case_status: 'negotiating' }, { case_status: 'open' }],
      select: {
        id: true,
        booking_id: true,
        case_status: true,
        created_at: true,
        updated_at: true,
      },
    });
    const due = stale.filter(
      (c) =>
        (c.case_status === 'open' ? c.created_at : c.updated_at) <= staleBefore,
    );
    for (const c of due) {
      await this.disputeEventsRepo.insert({
        dispute_case_id: c.id,
        actor_id: NIL_UUID,
        actor_role: 'system',
        event_type: 'escalated',
        message:
          c.case_status === 'open'
            ? 'Auto-escalated: the host did not respond in time'
            : 'Auto-escalated after no activity',
      });
      await this.disputeCasesRepo.update(
        { id: c.id },
        { case_status: 'escalated', updated_at: new Date() },
      );
      const staleBooking = await this.bookingsRepo.findOne({
        where: { id: c.booking_id },
        select: { guest_id: true, host_id: true, listing_id: true },
      });
      if (staleBooking) {
        const staleListing = await this.listingsRepo.findOne({
          where: { id: staleBooking.listing_id },
          select: { draft_data: true },
        });
        this.notifyDisputeEscalated(
          staleBooking,
          (staleListing?.draft_data as any)?.property_details?.title ??
            'the listing',
        );
      }
    }
    if (due.length > 0) {
      this.logger.log(
        `[escalateStaleNegotiations] escalated ${due.length} stale negotiation(s)`,
      );
    }
    return due.length;
  }

  async appealDispute(userId: string, bookingId: string, message: string) {
    const { booking, disputeCase, viewerRole } = await this.requireDisputeCase(
      userId,
      bookingId,
    );
    if (disputeCase.case_status !== 'admin_decided') {
      throw new ConflictException(
        'Only an admin-decided case may be appealed.',
      );
    }
    if (disputeCase.appeal_used) {
      throw new ConflictException(
        'This dispute has already been appealed once.',
      );
    }

    await this.disputeEventsRepo.insert({
      dispute_case_id: disputeCase.id,
      actor_id: userId,
      actor_role: viewerRole,
      event_type: 'appeal_raised',
      message,
    });
    await this.disputeCasesRepo.update(
      { id: disputeCase.id },
      { case_status: 'appealed', appeal_used: true, updated_at: new Date() },
    );

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle =
      (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    this.notifications.notify(
      'dispute.appeal_raised',
      booking.guest_id === userId ? booking.host_id : booking.guest_id,
      {
        listingTitle,
        link:
          viewerRole === 'guest'
            ? '/host?tab=bookings'
            : '/settings?tab=bookings',
      },
    );

    return { success: true, caseStatus: 'appealed' as const };
  }

  async releaseHold(id: string): Promise<void> {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: { status: true, guest_id: true, host_id: true, listing_id: true },
    });
    if (
      !booking ||
      (booking.status !== 'checked_in' && booking.status !== 'checked_out')
    ) {
      return;
    }
    const fromStatus = booking.status;

    // One transaction: the booking CAS takes the row lock first, so a dispute
    // opened concurrently either committed before us (CAS misses, we back off)
    // or waits for us (its own CAS then misses). The payment update is
    // status-guarded too; if it misses, everything rolls back.
    try {
      await this.dataSource.transaction(async (manager) => {
        await this.transition(manager, id, fromStatus, 'completed', null);
        await this.payments.release(id, manager);
      });
    } catch (err) {
      if (
        err instanceof ConflictException &&
        err.message === 'Booking status changed during operation'
      ) {
        this.logger.warn(
          `[releaseHold] booking ${id} status changed during release`,
        );
        return;
      }
      throw err;
    }

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle =
      (listing?.draft_data as any)?.property_details?.title ?? 'the listing';

    this.notifications.notify('booking.completed', booking.guest_id, {
      listingTitle,
      pushTitle: 'How was your stay?',
      pushBody: `Your stay at ${listingTitle} is complete — leave a review`,
      link: `/stays/${booking.listing_id}`,
    });
  }

  /** A request nobody answered within HOLD_TTL_MS stops blocking the guest's single hold slot. */
  async expireStaleHolds(): Promise<number> {
    const stale = await this.bookingsRepo.find({
      where: {
        status: In(HOST_PENDING_STATUSES),
        hold_expires_at: LessThan(new Date()),
      },
      select: { id: true, guest_id: true, status: true },
      take: 200,
    });
    let expired = 0;
    for (const booking of stale) {
      try {
        await this.dataSource.transaction((manager) =>
          this.transition(
            manager,
            booking.id,
            (booking.status ?? 'requested') as BookingStatus,
            'expired',
            null,
          ),
        );
      } catch (err) {
        if (err instanceof ConflictException) continue;
        throw err;
      }
      expired += 1;
      this.notifications.notify('booking.expired', booking.guest_id, {
        pushTitle: 'Booking request expired',
        pushBody: 'The host did not reply in time. You can send a new request.',
        link: '/account/bookings',
      });
    }
    return expired + (await this.expireUnpaidApprovals());
  }

  /**
   * Approved but never paid within pay_by_at: release the dates. A payment that
   * is (or just became) held is left alone; one that lands after expiry is
   * auto-refunded by onPaymentHeld.
   */
  private async expireUnpaidApprovals(): Promise<number> {
    const overdue = await this.bookingsRepo.find({
      where: {
        status: In(['confirmed', 'awaiting_payment']),
        pay_by_at: LessThan(new Date()),
      },
      select: { id: true, guest_id: true, status: true },
      take: 200,
    });
    let expired = 0;
    for (const booking of overdue) {
      try {
        let payment = await this.payments.getForBooking(booking.id);
        if (payment?.status === 'pending') {
          await this.syncPayment(booking.id);
          payment = await this.payments.getForBooking(booking.id);
        }
        if (
          payment &&
          payment.status !== 'pending' &&
          payment.status !== 'failed'
        ) {
          continue; // paid
        }
        await this.dataSource.transaction((manager) =>
          this.transition(
            manager,
            booking.id,
            (booking.status ?? 'confirmed') as BookingStatus,
            'expired',
            null,
          ),
        );
        await Promise.resolve(
          this.payments.closePendingOrder?.(booking.id),
        ).catch(() => undefined);
      } catch (err) {
        if (!(err instanceof ConflictException)) {
          this.logger.error(
            `[expireUnpaidApprovals] booking ${booking.id} failed`,
            err as Error,
          );
        }
        continue;
      }
      expired += 1;
      this.notifications.notify('booking.expired', booking.guest_id, {
        pushTitle: 'Booking expired',
        pushBody:
          'Payment was not completed in time, so the dates were released. You can send a new request.',
        link: '/account/bookings',
      });
    }
    return expired;
  }

  private stayConfirmationState(row: BookingEntity, userId: string) {
    const isGuest = row.guest_id === userId;
    return {
      canConfirm: this.isStayConfirmable(row),
      myConfirmed: Boolean(isGuest ? row.guest_confirmed_stay_at : row.host_confirmed_stay_at),
      otherConfirmed: Boolean(isGuest ? row.host_confirmed_stay_at : row.guest_confirmed_stay_at),
      confirmed: Boolean(row.stay_confirmed_at),
    };
  }

  private stayStart(booking: Pick<BookingEntity, 'checkin_time' | 'move_in'>): Date {
    return booking.checkin_time ?? new Date(`${booking.move_in}T00:00:00+05:30`);
  }

  private isStayConfirmable(booking: BookingEntity, now = new Date()): boolean {
    if (!['confirmed', 'checked_in', 'checked_out', 'completed'].includes(booking.status)) {
      return false;
    }
    return now.getTime() >= this.stayStart(booking).getTime() + STAY_CONFIRM_DELAY_MS;
  }

  /** 24h after check-in both sides are asked to confirm the stay happened. */
  async sendStayConfirmationPrompts(): Promise<number> {
    const cutoff = new Date(Date.now() - STAY_CONFIRM_DELAY_MS);
    const cutoffDay = cutoff.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const due = await this.bookingsRepo
      .createQueryBuilder('b')
      .where('b.stay_prompt_sent_at IS NULL')
      .andWhere('b.status IN (:...statuses)', {
        statuses: ['confirmed', 'checked_in', 'checked_out', 'completed'],
      })
      .andWhere(
        '((b.checkin_time IS NOT NULL AND b.checkin_time <= :cutoff) OR (b.checkin_time IS NULL AND b.move_in <= :cutoffDay))',
        { cutoff, cutoffDay },
      )
      .take(200)
      .getMany();

    let sent = 0;
    for (const booking of due) {
      const res = await this.bookingsRepo.update(
        { id: booking.id, stay_prompt_sent_at: IsNull() },
        { stay_prompt_sent_at: new Date() },
      );
      if (!res.affected) continue;
      sent += 1;
      for (const userId of [booking.guest_id, booking.host_id]) {
        this.notifications.notify('booking.stay_confirm_prompt', userId, {
          pushTitle: 'Did the stay happen?',
          pushBody: 'Confirm it in one tap. Reviews and verified-stay badges unlock once both sides confirm.',
          link: '/account/bookings',
        });
      }
    }
    return sent;
  }

  async confirmStay(userId: string, bookingId: string) {
    const booking = await this.bookingsRepo.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');

    const isGuest = booking.guest_id === userId;
    if (!isGuest && booking.host_id !== userId) {
      throw new ForbiddenException('You are not a party to this booking.');
    }
    if (!this.isStayConfirmable(booking)) {
      throw new BadRequestException('You can confirm a stay 24 hours after check-in.');
    }

    const now = new Date();
    const guestAt = isGuest ? (booking.guest_confirmed_stay_at ?? now) : booking.guest_confirmed_stay_at;
    const hostAt = isGuest ? booking.host_confirmed_stay_at : (booking.host_confirmed_stay_at ?? now);
    const bothAt = guestAt && hostAt ? (booking.stay_confirmed_at ?? now) : null;

    await this.bookingsRepo.update(
      { id: bookingId },
      {
        guest_confirmed_stay_at: guestAt,
        host_confirmed_stay_at: hostAt,
        stay_confirmed_at: bothAt,
      },
    );

    return {
      success: true,
      guestConfirmed: Boolean(guestAt),
      hostConfirmed: Boolean(hostAt),
      stayConfirmed: Boolean(bothAt),
    };
  }

  async releaseExpiredHolds(): Promise<number> {
    const due = await this.bookingsRepo.find({
      where: {
        status: In(['checked_in', 'checked_out']),
        escrow_release_time: LessThanOrEqual(new Date()),
      },
      select: { id: true },
    });
    for (const row of due) {
      try {
        await this.releaseHold(row.id);
      } catch (err) {
        this.logger.error(
          `[releaseExpiredHolds] booking ${row.id} failed`,
          err as Error,
        );
      }
    }
    if (due.length > 0) {
      this.logger.log(
        `[releaseExpiredHolds] released ${due.length} booking(s)`,
      );
    }
    return due.length;
  }

  private resolvedStayEnd(
    moveIn: string,
    moveOut: string,
    disputeCase: DisputeCaseEntity,
  ): string {
    const wanted = disputeCase.leaving_on
      ? calendarDayNumber(disputeCase.leaving_on)
      : todayDayNumberIST();
    const end = Math.min(
      calendarDayNumber(moveOut),
      Math.max(
        calendarDayNumber(moveIn),
        isNaN(wanted) ? todayDayNumberIST() : wanted,
      ),
    );
    return calendarDayToISO(end);
  }

  async resolveDispute(
    adminUserId: string,
    bookingId: string,
    amountToGuest: number,
    message: string | undefined,
  ) {
    const booking = await this.bookingsRepo.findOne({
      where: { id: bookingId },
      select: {
        status: true,
        guest_id: true,
        host_id: true,
        listing_id: true,
        move_in: true,
        move_out: true,
      },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.status !== 'disputed') {
      throw new ConflictException(
        `Cannot resolve a booking in status "${booking.status}"`,
      );
    }
    const disputeCase = await this.disputeCasesRepo.findOne({
      where: { booking_id: bookingId },
    });
    if (!disputeCase || disputeCase.case_status !== 'escalated') {
      throw new ConflictException('This dispute is not awaiting admin review.');
    }

    await this.dataSource.transaction(async (manager) => {
      await this.transition(
        manager,
        bookingId,
        'disputed',
        'completed',
        adminUserId,
        {
          actual_move_out: this.resolvedStayEnd(
            booking.move_in,
            booking.move_out,
            disputeCase,
          ),
        },
      );
      await this.payments.splitRelease(bookingId, amountToGuest, manager);
      await manager.getRepository(DisputeEventEntity).insert({
        dispute_case_id: disputeCase.id,
        actor_id: adminUserId,
        actor_role: 'admin',
        event_type: 'admin_decision',
        offer_amount: amountToGuest,
        message: message ?? null,
      });
      await manager.update(
        DisputeCaseEntity,
        { id: disputeCase.id },
        {
          case_status: 'admin_decided',
          resolution_amount_to_guest: amountToGuest,
          resolved_by: 'admin',
          updated_at: new Date(),
        },
      );
    });

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle =
      (listing?.draft_data as any)?.property_details?.title ?? 'the listing';

    const amounts = await this.disputeAmounts(bookingId, amountToGuest);
    this.notifications.notify('dispute.resolved', booking.guest_id, {
      listingTitle,
      ...amounts,
      decidedBy: 'admin',
      appealable: true,
      link: '/settings?tab=bookings',
    });
    this.notifications.notify('dispute.resolved', booking.host_id, {
      listingTitle,
      ...amounts,
      decidedBy: 'admin',
      appealable: true,
      link: '/host?tab=bookings',
    });

    return { success: true, status: 'completed' as const, amountToGuest };
  }

  async resolveAppeal(
    adminUserId: string,
    bookingId: string,
    amountToGuest: number,
    message: string | undefined,
  ) {
    const booking = await this.bookingsRepo.findOne({
      where: { id: bookingId },
      select: { guest_id: true, host_id: true, listing_id: true },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    const disputeCase = await this.disputeCasesRepo.findOne({
      where: { booking_id: bookingId },
    });
    if (!disputeCase || disputeCase.case_status !== 'appealed') {
      throw new ConflictException('This dispute is not under appeal.');
    }

    await this.dataSource.transaction(async (manager) => {
      // An appeal re-decides a payment the first decision already split.
      await this.payments.splitRelease(bookingId, amountToGuest, manager, [
        'split',
      ]);
      await manager.getRepository(DisputeEventEntity).insert({
        dispute_case_id: disputeCase.id,
        actor_id: adminUserId,
        actor_role: 'admin',
        event_type: 'appeal_decision',
        offer_amount: amountToGuest,
        message: message ?? null,
      });
      await manager.update(
        DisputeCaseEntity,
        { id: disputeCase.id, case_status: 'appealed' },
        {
          case_status: 'resolved',
          resolution_amount_to_guest: amountToGuest,
          resolved_by: 'appeal',
          updated_at: new Date(),
        },
      );
    });

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle =
      (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    const amounts = await this.disputeAmounts(bookingId, amountToGuest);
    this.notifications.notify('dispute.resolved', booking.guest_id, {
      listingTitle,
      ...amounts,
      decidedBy: 'appeal',
      link: '/settings?tab=bookings',
    });
    this.notifications.notify('dispute.resolved', booking.host_id, {
      listingTitle,
      ...amounts,
      decidedBy: 'appeal',
      link: '/host?tab=bookings',
    });

    return { success: true, status: 'resolved' as const, amountToGuest };
  }

  async checkout(userId: string, id: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: {
        status: true,
        guest_id: true,
        host_id: true,
        listing_id: true,
        move_out: true,
      },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.guest_id !== userId && booking.host_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    if (booking.status !== 'checked_in') {
      throw new ConflictException(
        `Cannot checkout a booking in status "${booking.status}"`,
      );
    }

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });

    const listingTitle =
      (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    const houseRules = (listing?.draft_data as any)?.house_rules;
    const checkoutTimeStr =
      houseRules?.check_out ?? houseRules?.checkOut ?? '11:00 AM';

    const now = new Date();
    const moveOutDate = calendarDayNumber(booking.move_out);
    const todayDate = todayDayNumber(now);

    const isGuest = booking.guest_id === userId;

    const dateBypass = ['true', '1'].includes(
      String(this.config.get('CHECKOUT_DATE_BYPASS')),
    );
    if (dateBypass) {
      this.logger.warn(
        `[checkout] date check bypassed for booking ${id} (CHECKOUT_DATE_BYPASS)`,
      );
    }

    if (dateBypass) {
    } else if (isGuest) {
      if (todayDayNumberIST(now) < moveOutDate) {
        throw new ConflictException(
          'You cannot check out before your move-out date. If you need to leave early or something is wrong with the stay, report it instead (choose "Leaving early" under Report a problem). There is no automatic refund for unused nights, and the payout stays on hold until the case is resolved.',
        );
      }
    } else {
      if (todayDate < moveOutDate) {
        throw new ConflictException(
          'You cannot check out a guest before their move-out date.',
        );
      }

      if (todayDate === moveOutDate) {
        const match = checkoutTimeStr.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
        let hours = 11;
        let minutes = 0;
        if (match) {
          hours = parseInt(match[1], 10);
          minutes = parseInt(match[2], 10);
          const ampm = match[3]?.toLowerCase();
          if (ampm === 'pm' && hours < 12) hours += 12;
          if (ampm === 'am' && hours === 12) hours = 0;
        }

        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();

        if (
          currentHour < hours ||
          (currentHour === hours && currentMinute < minutes)
        ) {
          throw new ConflictException(
            `You can only check out the guest after the official checkout time (${checkoutTimeStr}).`,
          );
        }
      }
    }

    const fromStatus = booking.status;
    await this.dataSource.transaction((manager) =>
      this.transition(manager, id, fromStatus, 'checked_out', userId, {
        checkout_time: now,
      }),
    );

    const otherParty = isGuest ? booking.host_id : booking.guest_id;
    const leftEarly = isGuest && todayDate < moveOutDate;
    const pushBody = leftEarly
      ? `Your guest has checked out early from ${listingTitle}`
      : isGuest
        ? `Your guest has checked out of ${listingTitle}`
        : `Your host has marked your stay at ${listingTitle} as completed`;

    this.notifications.notify(
      leftEarly ? 'booking.checked_out_early' : 'booking.checked_out',
      otherParty,
      {
        listingTitle,
        pushTitle: leftEarly ? 'Guest checked out early' : 'Stay completed',
        pushBody,
        link: isGuest ? '/host?tab=bookings' : `/stays/${booking.listing_id}`,
      },
    );

    return { success: true, status: 'checked_out' as const };
  }
}
