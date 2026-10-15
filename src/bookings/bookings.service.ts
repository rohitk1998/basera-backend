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
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThanOrEqual, Repository } from 'typeorm';
import { randomInt, randomUUID, timingSafeEqual } from 'crypto';
import {
  BookingEntity,
  BookingEventEntity,
  ListingEntity,
  PaymentEntity,
  UserEntity,
} from '../entities';
import { agreeTerms } from '../common/domain';
import { calendarDayNumber, calendarDayToISO, todayDayNumber, todayDayNumberIST } from '../common/calendar-date.util';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { SupabaseProvider } from '../auth/supabase.provider';
import { assertKycVerified } from '../user/verification-gate.util';
import { CreateBookingDto } from './dto/create-booking.dto';
import { DisputeBookingDto } from './dto/dispute-booking.dto';
import { ReviewEntity, DisputeCaseEntity, DisputeEventEntity, VerificationRequestEntity } from '../entities';

/** How a resolved dispute's payment was divided; null until a dispute settles. */
function splitResolution(payment: PaymentEntity | undefined | null) {
  if (!payment || payment.status !== 'split' || payment.split_amount_to_guest == null) return null;
  return { amountToGuest: payment.split_amount_to_guest, amountToHost: payment.amount - payment.split_amount_to_guest };
}

type UploadedMulterFile = { buffer: Buffer; mimetype: string; size: number };

const EVIDENCE_ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;

/** Rounds cap for guest<->host negotiation before it's forced to admin —
 *  a hard, small cap rather than an open-ended round count, so no separate
 *  timer/scheduler is needed just to bound how long negotiation can run. */
const NEGOTIATION_ROUNDS_CAP = 3;
/** A case with no reply in this long auto-escalates to admin — covers both a
 *  negotiating case gone quiet and an `open` one the host never answered
 *  (this is also the host's response deadline). Piggybacks on the existing
 *  release-scheduler's cron tick rather than standing up a second
 *  scheduler for one query. */
const NEGOTIATION_STALE_HOURS = 48;
/** No human actor for an auto-escalated dispute_events row — actor_id has
 *  no FK (unlike booking_events.actor, which does, to profiles), but a
 *  real-looking-but-fake uuid would be misleading in the data; the
 *  all-zeros nil UUID reads unambiguously as "not a real user" instead. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** A 4-digit code has only 10,000 values, so wrong guesses are capped per
 *  booking: after this many misses the booking is locked for the lockout
 *  window. In-memory (per process) — enough to stop online brute force from
 *  one instance; move to Redis if the API is ever scaled out. */
const CHECKIN_MAX_FAILED_ATTEMPTS = 5;
const CHECKIN_LOCKOUT_MS = 15 * 60 * 1000;

const ESCROW_HOLD_HOURS = 5 / 60; // 5 minutes for testing

/**
 * 4-digit numeric OTP, generated for the HOST at approval time — not the
 * guest. The guest only learns it by actually being physically present
 * (the host reads it out / shows it in person), and it's the guest who
 * submits it back to confirm check-in. That direction is the fraud check:
 * a host can't fake "the guest arrived" without the guest being there to
 * receive the code, and a guest can't fake it without actually showing up.
 */
function generateCheckinCode(): string {
  return String(randomInt(0, 10000)).padStart(4, '0');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-01" -> "1 Nov 2026", straight from the string so no timezone can shift it. */
function formatCalendarDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);
  private readonly checkinFailures = new Map<string, { count: number; lockedUntil: number }>();

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
  ) { }

  /** `manager` defaults to the module-level repo (every existing caller's
   *  behavior, unchanged) but can be passed an in-transaction EntityManager
   *  so this insert commits or rolls back together with whatever else that
   *  transaction is doing — see dispute() for the one caller that needs
   *  that. */
  private async recordEvent(
    bookingId: string,
    fromStatus: string | null,
    toStatus: string,
    actor: string | null,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager ? manager.getRepository(BookingEventEntity) : this.bookingEventsRepo;
    await repo.insert({
      booking_id: bookingId,
      from_status: fromStatus,
      to_status: toStatus,
      actor,
    });
  }

  /**
   * The monthly rent is read from the listing's own
   * `draft_data.property_details.price`, never from the request body — a guest
   * choosing their own price is the one thing this route cannot allow.
   *
   * Money stays integer rupees throughout, via `agreeTerms()`.
   */
  async create(userId: string, dto: CreateBookingDto) {
    const listing = await this.listingsRepo.findOne({
      where: { id: dto.listingId },
      select: { id: true, status: true, host_id: true, draft_data: true },
    });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    if (listing.status !== 'live') {
      throw new BadRequestException('This listing is not open for booking requests.');
    }

    if (listing.host_id === userId) {
      throw new ForbiddenException('You cannot book your own property.');
    }

    if (dto.role === 'host') {
      throw new ForbiddenException('You must switch to guest mode to book a property.');
    }

    const [requestingProfile, latestIdentity] = await Promise.all([
      this.profilesRepo.findOne({ where: { id: userId }, select: { id: true, selfie_uploaded_at: true } }),
      this.dataSource.getRepository(VerificationRequestEntity).findOne({
        where: { user_id: userId, verification_type: 'identity' },
        order: { submitted_at: 'DESC' },
      }),
    ]);
    if (!requestingProfile) {
      throw new NotFoundException('Profile not found');
    }
    // The gate is for the person, not the API — same principle as
    // host-listings.service.ts submitFull().
    assertKycVerified(requestingProfile, { identity: { status: latestIdentity?.status ?? 'not_started' } });

    // Calendar dates, compared as day numbers — no timezone conversion.
    const moveInDay = calendarDayNumber(dto.moveIn);
    const moveOutDay = calendarDayNumber(dto.moveOut);

    if (isNaN(moveInDay) || isNaN(moveOutDay)) {
      throw new BadRequestException('Invalid date format.');
    }
    if (moveInDay < todayDayNumber()) {
      throw new BadRequestException('Move-in date cannot be in the past.');
    }
    if (moveOutDay <= moveInDay) {
      throw new BadRequestException('Move-out date must be after move-in date.');
    }

    const overlapping = await this.bookingsRepo
      .createQueryBuilder('b')
      .where('b.listing_id = :listingId', { listingId: dto.listingId })
      .andWhere('b.status IN (:...statuses)', { statuses: ['confirmed', 'approved', 'checked_in', 'disputed', 'completed', 'checked_out'] })
      .andWhere('b.move_in < :moveOut', { moveOut: dto.moveOut })
      .andWhere('COALESCE(b.actual_move_out, b.move_out) > :moveIn', { moveIn: dto.moveIn })
      .getOne();

    if (overlapping) {
      throw new ConflictException('This property is not available for the selected dates.');
    }

    const selfOverlapping = await this.bookingsRepo
      .createQueryBuilder('b')
      .where('b.listing_id = :listingId', { listingId: dto.listingId })
      .andWhere('b.guest_id = :userId', { userId })
      .andWhere('b.status = :status', { status: 'requested' })
      .andWhere('b.move_in < :moveOut', { moveOut: dto.moveOut })
      .andWhere('b.move_out > :moveIn', { moveIn: dto.moveIn })
      .getOne();

    if (selfOverlapping) {
      throw new ConflictException('You already have a pending request for this property for these dates.');
    }

    const propertyDetails =
      (listing.draft_data as Record<string, any>)?.property_details ?? {};
    const listingTitle = propertyDetails.title ?? 'the listing';
    const dailyBaseRate = propertyDetails.dailyBaseRate ?? Math.round((propertyDetails.price || propertyDetails.monthlyRent || 12000) / 30);

    if (typeof dailyBaseRate !== 'number' || isNaN(dailyBaseRate)) {
      throw new InternalServerErrorException('Listing is missing pricing information');
    }

    const weeklyDiscountPct = propertyDetails.weeklyDiscountPct ?? 15;
    const monthlyDiscountPct = propertyDetails.monthlyDiscountPct ?? 40;

    // Infants and pets don't count against a bed/room capacity limit the
    // same way an adult or child does — matches how GuestsPicker's own
    // client-side copy frames them (infants: "Under 2", pets: a separate
    // "bringing a service animal?" link, not folded into headcount).
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

    const minDays = propertyDetails.minDays;
    if (typeof minDays === 'number' && dto.days < minDays) {
      throw new BadRequestException(`This property has a minimum stay of ${minDays} day${minDays === 1 ? '' : 's'}.`);
    }

    // agreeTerms is pure arithmetic (see common/domain.ts) — it never
    // throws, so nothing before the insert below can produce a client-
    // shaped error. Only the insert itself can genuinely fail, and that
    // failure is a server-side problem (a bad connection, a constraint
    // violation, the DB being unreachable), not something the caller did
    // wrong — the old catch-all here mislabelled any such failure as a 400
    // and leaked the raw driver message straight to the client.
    const terms = agreeTerms(
      dailyBaseRate,
      weeklyDiscountPct,
      monthlyDiscountPct,
      dto.days,
      dto.paymentMethod
    );

    const commissionPercentage = this.config.get<number>('PLATFORM_COMMISSION_PERCENTAGE')!;
    const grossBookingAmount = terms.totalRent;
    const platformCommission = Math.round(grossBookingAmount * (commissionPercentage / 100));
    const hostPayoutAmount = grossBookingAmount - platformCommission;

    let inserted;
    try {
      inserted = await this.bookingsRepo.insert({
        listing_id: dto.listingId,
        guest_id: userId,
        host_id: listing.host_id,
        status: 'requested',
        move_in: dto.moveIn,
        move_out: dto.moveOut,
        months: dto.days, // Storing days in the legacy "months" column
        adults,
        children,
        infants,
        pets,
        monthly_rent: terms.totalRent, // Storing total rent in the legacy "monthly_rent" column
        deposit: terms.deposit,
        payment_method: terms.paymentMethod,
        due_at_move_in: terms.dueAtMoveIn,
        gross_booking_amount: grossBookingAmount,
        platform_commission: platformCommission,
        host_payout_amount: hostPayoutAmount,
      });
    } catch (e: any) {
      this.logger.error('[create] booking insert failed', e);
      throw new InternalServerErrorException('Could not create the booking. Please try again.');
    }
    
    const bookingId = inserted.identifiers[0]?.id as string;
    if (!bookingId) {
      throw new InternalServerErrorException('Database error');
    }

    await this.recordEvent(bookingId, null, 'requested', userId);

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

    return { success: true, id: bookingId, status: 'requested' as const };
  }

  /**
   * The caller's own bookings, as guest or host. Rows are flattened with the
   * listing title read out of `draft_data` here rather than handed back raw.
   * Paginated — this list has no natural cap (every booking a user has ever
   * made) and was previously fetched in full on every call.
   */
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

    const [listingRows, profileRows, paymentsByBookingId, reviewsRows] = await Promise.all([
      listingIds.length
        ? this.listingsRepo.find({ where: listingIds.map((id) => ({ id })), select: { id: true, draft_data: true } })
        : Promise.resolve([] as ListingEntity[]),
      counterpartIds.length
        ? this.profilesRepo.find({ where: counterpartIds.map((id) => ({ id })), select: { id: true, full_name: true } })
        : Promise.resolve([] as UserEntity[]),
      this.payments.getForBookings(rows.map((row) => row.id)),
      this.reviewsRepo.find({ where: { author_id: userId }, select: { booking_id: true } }),
    ]);

    const titleById = new Map(
      listingRows.map((l) => [l.id, (l.draft_data as any)?.property_details?.title ?? 'Listing']),
    );
    const nameById = new Map(profileRows.map((p) => [p.id, p.full_name ?? 'Basera user']));
    const paidByBookingId = new Set(
      Array.from(paymentsByBookingId.values())
        .filter((p) => p.status !== 'refunded')
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
      // Host-only: the guest proves presence by entering it, so must never read it.
      checkinCode: role === 'host' ? row.checkin_code : null,
      checkinTime: row.checkin_time,
      escrowReleaseTime: row.escrow_release_time,
      rejectionReason: row.rejection_reason,
      isPaid: paidByBookingId.has(row.id),
      hasReviewed: reviewsRows ? reviewsRows.some((r) => r.booking_id === row.id) : false,
      counterpartName: nameById.get(role === 'host' ? row.guest_id : row.host_id) ?? 'Basera user',
      createdAt: row.created_at,
    }));

    return { success: true, bookings, page, pageSize, total };
  }

  /**
   * A single booking, for whichever party is on it. No RLS backs this table,
   * so the guest/host check happens here by hand.
   */
  async getById(userId: string, id: string) {
    const row = await this.bookingsRepo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Booking not found');
    }
    if (row.guest_id !== userId && row.host_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }

    const [listing, hostProfile] = await Promise.all([
      this.listingsRepo.findOne({ where: { id: row.listing_id }, select: { draft_data: true } }),
      this.profilesRepo.findOne({ where: { id: row.host_id }, select: { full_name: true } }),
    ]);

    const payment = await this.payments.getForBooking(row.id);

    const booking = {
      id: row.id,
      listingId: row.listing_id,
      listingTitle: (listing?.draft_data as any)?.property_details?.title ?? 'Listing',
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
      // Host-only, see list().
      checkinCode: row.host_id === userId ? row.checkin_code : null,
      checkinTime: row.checkin_time,
      escrowReleaseTime: row.escrow_release_time,
      paymentStatus: payment?.status ?? null,
    };

    return { success: true, booking };
  }

  /**
   * Host approves a request. This moves the booking straight from `requested`
   * to `confirmed` — there is no payment gate to hold an intermediate
   * `approved` state open for, so a single host action is both the approval
   * and the confirmation.
   *
   * No check-in OTP exists yet: it is generated in pay(), once payment is
   * held, so an unpaid booking never has a code.
   */
  async approve(userId: string, id: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: { status: true, host_id: true, guest_id: true, listing_id: true, move_in: true },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.host_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    if (booking.status !== 'requested') {
      throw new ConflictException(`Cannot approve a booking in status "${booking.status}"`);
    }

    const updateRes = await this.bookingsRepo.update(
      { id, status: 'requested' },
      { status: 'confirmed', updated_at: new Date() },
    );
    if (updateRes.affected === 0) {
      throw new ConflictException('Booking status changed during operation');
    }
    await this.recordEvent(id, 'requested', 'confirmed', userId);

    const [listing, hostProfile] = await Promise.all([
      this.listingsRepo.findOne({ where: { id: booking.listing_id }, select: { draft_data: true } }),
      this.profilesRepo.findOne({ where: { id: booking.host_id }, select: { full_name: true } }),
    ]);

    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
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

  /** Host declines a request. Only valid while it is still `requested`. */
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
    if (booking.status !== 'requested') {
      throw new ConflictException(`Cannot decline a booking in status "${booking.status}"`);
    }

    const updateRes = await this.bookingsRepo.update(
      { id, status: 'requested' },
      { status: 'declined', rejection_reason: reason, updated_at: new Date() }
    );
    if (updateRes.affected === 0) {
      throw new ConflictException('Booking status changed during operation');
    }
    await this.recordEvent(id, 'requested', 'declined', userId);

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';

    this.notifications.notify('booking.declined', booking.guest_id, {
      listingTitle,
      pushTitle: 'Booking request declined',
      pushBody: `The host declined your request for ${listingTitle}`,
      link: '/stays',
    });

    return { success: true, status: 'declined' as const };
  }

  /** Either party can cancel a request that hasn't completed yet. */
  async cancel(userId: string, id: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: { status: true, host_id: true, guest_id: true, listing_id: true },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.host_id !== userId && booking.guest_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    if (booking.status !== 'requested' && booking.status !== 'confirmed') {
      throw new ConflictException(`Cannot cancel a booking in status "${booking.status}"`);
    }

    const fromStatus = booking.status;
    const updateRes = await this.bookingsRepo.update({ id, status: fromStatus }, { status: 'cancelled', updated_at: new Date() });
    if (updateRes.affected === 0) {
      throw new ConflictException('Booking status changed during operation');
    }
    await this.recordEvent(id, fromStatus, 'cancelled', userId);

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    const otherParty = userId === booking.guest_id ? booking.host_id : booking.guest_id;

    this.notifications.notify('booking.cancelled', otherParty, {
      listingTitle,
      pushTitle: 'Booking cancelled',
      pushBody: `The booking for ${listingTitle} has been cancelled`,
      link: userId === booking.guest_id ? '/host?tab=bookings' : '/stays',
    });

    return { success: true, status: 'cancelled' as const };
  }

  /**
   * Guest pays and holds their dates. Booking status stays `confirmed` —
   * payment state lives entirely in the `payments` table (its own ledger,
   * mirrored by `booking_events` for status), not a new booking status.
   * Independent of the check-in OTP, which is generated at approve() time
   * for the host, not here — payment and physical check-in are two
   * separate gates, and both must clear before the 24h clock starts.
   */
  async pay(userId: string, id: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: {
        status: true,
        guest_id: true,
        host_id: true,
        listing_id: true,
        due_at_move_in: true,
        move_in: true,
        move_out: true,
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
    if (booking.status !== 'confirmed') {
      throw new ConflictException(`Cannot pay for a booking in status "${booking.status}"`);
    }
    const existing = await this.payments.getForBooking(id);
    if (existing) {
      throw new ConflictException('This booking has already been paid for.');
    }

    // This check-then-insert is a fast path, not the actual guarantee: two
    // concurrent pay() calls can both pass the check above before either
    // commits. The unique index on payments.booking_id (see
    // createHeldPayment) is what closes that race — its second insert
    // fails and createHeldPayment turns that into the same
    // ConflictException this method would have thrown had it lost the race
    // up here instead.
    //
    // The mocked Cashfree Easy Split payload built inside createHeldPayment
    // uses host_payout_amount/platform_commission exactly as computed at
    // booking creation — no additional gateway/UPI fee is deducted from the
    // host's split here.
    await this.payments.createHeldPayment(id, booking.due_at_move_in, {
      hostId: booking.host_id,
      hostPayoutAmount: booking.host_payout_amount,
      platformCommission: booking.platform_commission,
    });

    // Generated only now that payment is held, and readable by the HOST only
    // (list()/getById() withhold it from the guest). The guest learns it by
    // meeting the host, and submits it back in checkin().
    await this.bookingsRepo.update(
      { id, status: 'confirmed' },
      { checkin_code: generateCheckinCode(), updated_at: new Date() },
    );

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';

    this.notifications.notify('booking.payment_held', booking.host_id, {
      listingTitle,
      pushTitle: 'Payment received and held',
      pushBody: `Payment for ${listingTitle} is held — your guest is on their way`,
      link: '/host?tab=bookings',
    });

    // Guest receipt. Deliberately carries no check-in code — the code is
    // host-only and this payload is persisted in notification_log.
    this.notifications.notify('booking.payment_receipt', booking.guest_id, {
      listingTitle,
      moveIn: booking.move_in,
      moveOut: booking.move_out,
      amount: booking.due_at_move_in,
      pushTitle: 'Payment received',
      pushBody: `Your payment for ${listingTitle} is held by Basera until 24 hours after check-in`,
      link: '/settings?tab=bookings',
    });

    // Tells the host the code is ready; the code itself is not in the payload
    // (it would land in notification_log) — the host reads it on /host/bookings.
    this.notifications.notify('booking.checkin_code_ready', booking.host_id, {
      listingTitle,
      pushTitle: 'Check-in code ready',
      pushBody: `Your guest's check-in code for ${listingTitle} is ready — give it to them in person on arrival`,
      link: '/host?tab=bookings',
    });

    return { success: true, status: 'confirmed' as const };
  }

  /**
   * Guest submits the OTP the host gave them in person, to confirm they
   * physically reached the property — this is guest-only, never the host,
   * since the host already knows the code and submitting it themselves
   * would prove nothing. Requires a held payment to already exist: both
   * the payment gate and this physical-presence gate must clear before
   * the 24h release clock starts.
   */
  async checkin(userId: string, id: string, code: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: { status: true, guest_id: true, host_id: true, listing_id: true, checkin_code: true, move_in: true, move_out: true },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.guest_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    if (booking.status !== 'confirmed') {
      throw new ConflictException(`Cannot check in a booking in status "${booking.status}"`);
    }
    const payment = await this.payments.getForBooking(id);
    if (!payment || payment.status !== 'held') {
      throw new ConflictException('Payment must be completed before check-in.');
    }
    // Calendar-day window in India time. Rejected before the code is even
    // looked at, so an early attempt never counts toward the lockout.
    const today = todayDayNumberIST();
    if (today < calendarDayNumber(booking.move_in)) {
      throw new BadRequestException(`Check-in opens on ${formatCalendarDate(booking.move_in)}.`);
    }
    if (today > calendarDayNumber(booking.move_out)) {
      throw new BadRequestException(`Check-in is closed — this stay ended on ${formatCalendarDate(booking.move_out)}.`);
    }
    const failure = this.checkinFailures.get(id);
    if (failure && failure.lockedUntil > Date.now()) {
      const retryAfterSeconds = Math.ceil((failure.lockedUntil - Date.now()) / 1000);
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
    const expected = booking.checkin_code ? Buffer.from(booking.checkin_code) : null;
    const given = Buffer.from(code);
    if (!expected || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      const count = (failure && failure.count < CHECKIN_MAX_FAILED_ATTEMPTS ? failure.count : 0) + 1;
      this.checkinFailures.set(id, {
        count,
        lockedUntil: count >= CHECKIN_MAX_FAILED_ATTEMPTS ? Date.now() + CHECKIN_LOCKOUT_MS : 0,
      });
      throw new BadRequestException('That check-in code is incorrect.');
    }
    this.checkinFailures.delete(id);

    const now = new Date();
    const escrowReleaseTime = new Date(now.getTime() + ESCROW_HOLD_HOURS * 60 * 60 * 1000);

    const updateRes = await this.bookingsRepo.update(
      { id, status: 'confirmed' },
      { status: 'checked_in', checkin_time: now, escrow_release_time: escrowReleaseTime, updated_at: now },
    );
    if (updateRes.affected === 0) {
      throw new ConflictException('Booking status changed during operation');
    }
    await this.recordEvent(id, 'confirmed', 'checked_in', userId);

    const [listing, guestProfile] = await Promise.all([
      this.listingsRepo.findOne({ where: { id: booking.listing_id }, select: { draft_data: true } }),
      this.profilesRepo.findOne({ where: { id: booking.guest_id }, select: { full_name: true } }),
    ]);
    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
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

  /**
   * Guest-only, only while `checked_in` and before `escrow_release_time`.
   * Reuses the existing `rejection_reason` column rather than adding a new
   * one for a single string.
   */
  async dispute(userId: string, id: string, dto: DisputeBookingDto) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: { status: true, guest_id: true, host_id: true, listing_id: true, escrow_release_time: true, move_out: true },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.guest_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    if (booking.status !== 'checked_in') {
      throw new ConflictException(`Cannot dispute a booking in status "${booking.status}"`);
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
        throw new BadRequestException('Leaving date must be before the move-out date.');
      }
    }
    if (booking.escrow_release_time && booking.escrow_release_time.getTime() <= Date.now()) {
      throw new ConflictException('The dispute window for this booking has closed.');
    }

    const payment = await this.payments.getForBooking(id);
    // Optional only for early_departure (no amount requested = 0 on the case).
    const requestedAmount = dto.requestedAmount ?? 0;
    if (payment && requestedAmount > payment.amount) {
      throw new BadRequestException('Requested amount cannot exceed the amount paid.');
    }

    // All 4 writes below (status update, booking event, dispute case,
    // dispute event) commit or roll back together — a crash or error
    // between any two of them used to leave a booking marked `disputed`
    // with no corresponding dispute_cases row, or a case with no opening
    // event.
    const disputeCase = await this.dataSource.transaction(async (manager) => {
      const updateRes = await manager.update(
        BookingEntity,
        { id, status: 'checked_in' },
        { status: 'disputed', updated_at: new Date() },
      );
      if (updateRes.affected === 0) {
        throw new ConflictException('Booking status changed during operation');
      }
      await this.recordEvent(id, 'checked_in', 'disputed', userId, manager);

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
      this.listingsRepo.findOne({ where: { id: booking.listing_id }, select: { draft_data: true } }),
      this.profilesRepo.findOne({ where: { id: booking.guest_id }, select: { full_name: true } }),
    ]);
    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    const guestName = guestProfile?.full_name ?? 'Your guest';

    this.notifications.notify('booking.disputed', booking.host_id, {
      listingTitle,
      guestName,
      pushTitle: 'Dispute raised',
      pushBody: `${guestName} raised a dispute for ${listingTitle} — Basera is reviewing`,
      link: '/host?tab=bookings',
    });
    this.notifications.notify('dispute.raised_confirmation', booking.guest_id, {
      listingTitle,
      link: '/settings?tab=bookings',
    });

    return { success: true, status: 'disputed' as const, disputeCaseId: disputeCase.id };
  }

  /** Guest or host of the booking only. Backs the case panel both sides
   *  see, and the evidence-add/offer/respond/appeal endpoints' own guards. */
  private async requireDisputeCase(userId: string, bookingId: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id: bookingId },
      select: { guest_id: true, host_id: true, listing_id: true, move_in: true, move_out: true },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.guest_id !== userId && booking.host_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    const disputeCase = await this.disputeCasesRepo.findOne({ where: { booking_id: bookingId } });
    if (!disputeCase) {
      throw new NotFoundException('No dispute found for this booking');
    }
    return { booking, disputeCase, viewerRole: (booking.guest_id === userId ? 'guest' : 'host') as 'guest' | 'host' };
  }

  /** Full case for the guest/host panel or admin's case view — claim,
   *  evidence, and the whole negotiation/decision timeline. */
  async getDisputeCase(userId: string, bookingId: string) {
    const { disputeCase, viewerRole } = await this.requireDisputeCase(userId, bookingId);
    return { success: true, viewerRole, ...(await this.loadDisputeTimeline(disputeCase)) };
  }

  /** Same payload for an admin, who is neither guest nor host of the booking
   *  (requireDisputeCase would 403 them) — the caller must already be
   *  admin-guarded. */
  async getDisputeCaseForAdmin(bookingId: string) {
    const disputeCase = await this.disputeCasesRepo.findOne({ where: { booking_id: bookingId } });
    if (!disputeCase) {
      throw new NotFoundException('No dispute found for this booking');
    }
    return { success: true, viewerRole: 'admin' as const, ...(await this.loadDisputeTimeline(disputeCase)) };
  }

  private async loadDisputeTimeline(disputeCase: DisputeCaseEntity) {
    const events = await this.disputeEventsRepo.find({
      where: { dispute_case_id: disputeCase.id },
      order: { created_at: 'ASC' },
    });
    // The clock the scheduler escalates on: an unanswered `open` case runs
    // from when it was raised, a negotiating one from its last activity.
    const clockStart =
      disputeCase.case_status === 'open'
        ? disputeCase.created_at
        : disputeCase.case_status === 'negotiating'
          ? disputeCase.updated_at
          : null;
    const responseDeadline = clockStart
      ? new Date(new Date(clockStart).getTime() + NEGOTIATION_STALE_HOURS * 60 * 60 * 1000).toISOString()
      : null;
    return { case: disputeCase, events, responseDeadline };
  }

  /** Either party may attach more evidence to an already-open case — this
   *  is what lets a host add their side's photos without it being folded
   *  into the original claim DTO. Uploads to Storage itself, same pattern
   *  as UserService.uploadAvatar: service-role client, validated
   *  type/size, a stable-but-unguessable path, then the permanent public
   *  CDN URL is what gets stored on the case row. */
  async addDisputeEvidence(userId: string, bookingId: string, files: UploadedMulterFile[]) {
    const { disputeCase } = await this.requireDisputeCase(userId, bookingId);
    if (files.length === 0) {
      throw new BadRequestException('No files provided');
    }
    if (disputeCase.evidence_urls.length + files.length > 6) {
      throw new BadRequestException('A dispute may have at most 6 evidence files.');
    }

    const urls: string[] = [];
    for (const file of files) {
      const ext = EVIDENCE_ALLOWED_TYPES[file.mimetype];
      if (!ext) {
        throw new BadRequestException('Unsupported file type. Use JPEG, PNG or WebP.');
      }
      if (file.size > EVIDENCE_MAX_BYTES) {
        throw new PayloadTooLargeException('File too large. Maximum size is 5 MB.');
      }

      const storagePath = `${bookingId}/${randomUUID()}.${ext}`;
      const { error: uploadError } = await this.supabase.client.storage
        .from('dispute-evidence')
        .upload(storagePath, file.buffer, { contentType: file.mimetype });
      if (uploadError) {
        throw new InternalServerErrorException('Upload failed. Please try again.');
      }

      const {
        data: { publicUrl },
      } = this.supabase.client.storage.from('dispute-evidence').getPublicUrl(storagePath);
      urls.push(publicUrl);
    }

    await this.disputeCasesRepo.update(
      { id: disputeCase.id },
      { evidence_urls: [...disputeCase.evidence_urls, ...urls], updated_at: new Date() },
    );
    return { success: true, evidenceUrls: urls };
  }

  /**
   * A host (or guest countering back) proposes an amount-to-guest split.
   * Turn alternates strictly by actor_role — enforced by looking at the
   * last event's role rather than a separate "whose turn" column, since
   * the event log is already the source of truth for everything else here.
   */
  async makeDisputeOffer(userId: string, bookingId: string, amountToGuest: number, message: string | undefined) {
    const { booking, disputeCase, viewerRole } = await this.requireDisputeCase(userId, bookingId);
    if (disputeCase.case_status !== 'open' && disputeCase.case_status !== 'negotiating') {
      throw new ConflictException(`Cannot make an offer on a case in status "${disputeCase.case_status}"`);
    }

    const payment = await this.payments.getForBooking(bookingId);
    if (payment && (amountToGuest < 0 || amountToGuest > payment.amount)) {
      throw new BadRequestException('amountToGuest must be between 0 and the amount paid.');
    }
    if (disputeCase.negotiation_rounds >= NEGOTIATION_ROUNDS_CAP) {
      throw new ConflictException('Negotiation rounds are exhausted — escalate to Basera instead.');
    }

    const lastEvent = await this.disputeEventsRepo.findOne({
      where: { dispute_case_id: disputeCase.id },
      order: { created_at: 'DESC' },
    });
    // The claim itself (actor_role 'guest') doesn't count as "guest's turn
    // taken" for offer purposes — the host always makes the first offer.
    const lastOfferRole = lastEvent?.event_type === 'claim_raised' ? null : lastEvent?.actor_role ?? null;
    if (lastOfferRole === viewerRole) {
      throw new ConflictException('Waiting on the other party — not your turn to offer.');
    }
    // The host always makes the first offer; a guest can only counter one.
    if (viewerRole === 'guest' && lastOfferRole === null) {
      throw new ForbiddenException('Only the host can make the first offer.');
    }

    const eventType = viewerRole === 'host' ? (lastOfferRole === null ? 'host_offer' : 'host_counter') : 'guest_counter';

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
      { case_status: 'negotiating', negotiation_rounds: disputeCase.negotiation_rounds + 1, updated_at: new Date() },
    );

    const listing = await this.listingsRepo.findOne({ where: { id: booking.listing_id }, select: { draft_data: true } });
    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    const recipient = viewerRole === 'host' ? booking.guest_id : booking.host_id;
    this.notifications.notify('dispute.offer_received', recipient, {
      listingTitle,
      offerAmount: amountToGuest,
      link: viewerRole === 'host' ? '/settings?tab=bookings' : '/host?tab=bookings',
    });

    return { success: true, caseStatus: 'negotiating' as const };
  }

  /**
   * The other party's reply to the standing offer: accept settles the
   * dispute right there (money moves immediately, same philosophy as the
   * existing binary resolve — resolution = payout in the same call);
   * reject or escalate both hand the case to admin, with no distinction
   * between the two visible to admin beyond the timeline itself.
   */
  async respondToDisputeOffer(userId: string, bookingId: string, action: 'accept' | 'reject' | 'escalate') {
    const { booking, disputeCase, viewerRole } = await this.requireDisputeCase(userId, bookingId);
    if (disputeCase.case_status !== 'negotiating' && !(action === 'escalate' && disputeCase.case_status === 'open')) {
      throw new ConflictException(`Cannot respond to a case in status "${disputeCase.case_status}"`);
    }

    if (action === 'accept') {
      const lastOffer = await this.disputeEventsRepo.findOne({
        where: { dispute_case_id: disputeCase.id },
        order: { created_at: 'DESC' },
      });
      if (!lastOffer || lastOffer.offer_amount === null || lastOffer.actor_role === viewerRole) {
        throw new ConflictException('No standing offer to accept.');
      }

      await this.payments.splitRelease(bookingId, lastOffer.offer_amount);
      await this.bookingsRepo.update(
        { id: bookingId, status: 'disputed' },
        { status: 'completed', actual_move_out: this.resolvedStayEnd(booking.move_in, booking.move_out, disputeCase), updated_at: new Date() },
      );
      await this.recordEvent(bookingId, 'disputed', 'completed', userId);
      await this.disputeEventsRepo.insert({
        dispute_case_id: disputeCase.id,
        actor_id: userId,
        actor_role: viewerRole,
        event_type: 'accepted',
        offer_amount: lastOffer.offer_amount,
      });
      await this.disputeCasesRepo.update(
        { id: disputeCase.id },
        {
          case_status: 'resolved',
          resolution_amount_to_guest: lastOffer.offer_amount,
          resolved_by: 'negotiation',
          updated_at: new Date(),
        },
      );

      const listing = await this.listingsRepo.findOne({ where: { id: booking.listing_id }, select: { draft_data: true } });
      const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
      const otherParty = viewerRole === 'guest' ? booking.host_id : booking.guest_id;
      const amounts = await this.disputeAmounts(bookingId, lastOffer.offer_amount);
      const linkFor = (role: 'guest' | 'host') => (role === 'host' ? '/host?tab=bookings' : '/settings?tab=bookings');
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

    // reject / escalate — both hand off to admin.
    await this.disputeEventsRepo.insert({
      dispute_case_id: disputeCase.id,
      actor_id: userId,
      actor_role: viewerRole,
      event_type: action === 'reject' ? 'rejected' : 'escalated',
    });
    await this.disputeCasesRepo.update({ id: disputeCase.id }, { case_status: 'escalated', updated_at: new Date() });

    const listing = await this.listingsRepo.findOne({ where: { id: booking.listing_id }, select: { draft_data: true } });
    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    if (action === 'reject') {
      this.notifications.notify('dispute.offer_rejected', booking.guest_id === userId ? booking.host_id : booking.guest_id, {
        listingTitle,
        link: viewerRole === 'guest' ? '/host?tab=bookings' : '/settings?tab=bookings',
      });
    }
    this.notifyDisputeEscalated(booking, listingTitle);

    return { success: true, caseStatus: 'escalated' as const };
  }

  /** Escalation email + inbox entry to both sides, each with their own link. */
  private notifyDisputeEscalated(booking: { guest_id: string; host_id: string }, listingTitle: string): void {
    this.notifications.notify('dispute.escalated', booking.guest_id, { listingTitle, link: '/settings?tab=bookings' });
    this.notifications.notify('dispute.escalated', booking.host_id, { listingTitle, link: '/host?tab=bookings' });
  }

  /** Refund/payout split for a resolution email. Read-only: the paid amount is
   *  the same `payment.amount` splitRelease validates `amountToGuest` against. */
  private async disputeAmounts(bookingId: string, amountToGuest: number) {
    // Best effort: the resolution is already committed, so a failed lookup
    // only drops the host amount from the email rather than failing the call.
    let payment: Awaited<ReturnType<PaymentsService['getForBooking']>> = null;
    try {
      payment = await this.payments.getForBooking(bookingId);
    } catch (err) {
      this.logger.warn(`[disputeAmounts] payment lookup failed for booking ${bookingId}: ${String(err)}`);
    }
    return {
      amountToGuest,
      amountToHost: payment ? Math.max(0, payment.amount - amountToGuest) : undefined,
    };
  }

  /** A case with no activity in NEGOTIATION_STALE_HOURS forces to admin —
   *  negotiating ones from their last activity, `open` ones (host never
   *  replied) from when they were raised. Called from the same cron tick as
   *  releaseExpiredHolds rather than a second scheduler for one query. */
  async escalateStaleNegotiations(): Promise<number> {
    const staleBefore = new Date(Date.now() - NEGOTIATION_STALE_HOURS * 60 * 60 * 1000);
    const stale = await this.disputeCasesRepo.find({
      where: [{ case_status: 'negotiating' }, { case_status: 'open' }],
      select: { id: true, booking_id: true, case_status: true, created_at: true, updated_at: true },
    });
    const due = stale.filter((c) => (c.case_status === 'open' ? c.created_at : c.updated_at) <= staleBefore);
    for (const c of due) {
      await this.disputeEventsRepo.insert({
        dispute_case_id: c.id,
        actor_id: NIL_UUID,
        actor_role: 'system',
        event_type: 'escalated',
        message:
          c.case_status === 'open' ? 'Auto-escalated: the host did not respond in time' : 'Auto-escalated after no activity',
      });
      await this.disputeCasesRepo.update({ id: c.id }, { case_status: 'escalated', updated_at: new Date() });
      const staleBooking = await this.bookingsRepo.findOne({
        where: { id: c.booking_id },
        select: { guest_id: true, host_id: true, listing_id: true },
      });
      if (staleBooking) {
        const staleListing = await this.listingsRepo.findOne({ where: { id: staleBooking.listing_id }, select: { draft_data: true } });
        this.notifyDisputeEscalated(staleBooking, (staleListing?.draft_data as any)?.property_details?.title ?? 'the listing');
      }
    }
    if (due.length > 0) {
      this.logger.log(`[escalateStaleNegotiations] escalated ${due.length} stale negotiation(s)`);
    }
    return due.length;
  }

  /** Either party, once, after an admin decision — reopens for a final
   *  second look. appeal_used is the entire enforcement of "once". */
  async appealDispute(userId: string, bookingId: string, message: string) {
    const { booking, disputeCase, viewerRole } = await this.requireDisputeCase(userId, bookingId);
    if (disputeCase.case_status !== 'admin_decided') {
      throw new ConflictException('Only an admin-decided case may be appealed.');
    }
    if (disputeCase.appeal_used) {
      throw new ConflictException('This dispute has already been appealed once.');
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

    const listing = await this.listingsRepo.findOne({ where: { id: booking.listing_id }, select: { draft_data: true } });
    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    this.notifications.notify('dispute.appeal_raised', booking.guest_id === userId ? booking.host_id : booking.guest_id, {
      listingTitle,
      link: viewerRole === 'guest' ? '/host?tab=bookings' : '/settings?tab=bookings',
    });

    return { success: true, caseStatus: 'appealed' as const };
  }

  /**
   * Auto-release a single held booking past its `escrow_release_time`.
   * Called by the scheduler (booking-release.scheduler.ts) — the single
   * code path for reaching `completed` in this model, so an admin manual
   * override would also call this, not a parallel implementation.
   */
  async releaseHold(id: string): Promise<void> {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: { status: true, guest_id: true, host_id: true, listing_id: true },
    });
    // `checked_out` too: a guest (or host) who checks out inside the hold window
    // still has an unreleased payment, paid out at the same escrow_release_time.
    if (!booking || (booking.status !== 'checked_in' && booking.status !== 'checked_out')) {
      return;
    }
    const fromStatus = booking.status;

    await this.payments.release(id);

    const updateRes = await this.bookingsRepo.update(
      { id, status: fromStatus },
      { status: 'completed', updated_at: new Date() },
    );
    if (updateRes.affected === 0) {
      this.logger.warn(`[releaseHold] booking ${id} status changed during release`);
      return;
    }
    await this.recordEvent(id, fromStatus, 'completed', null);

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';

    this.notifications.notify('booking.completed', booking.guest_id, {
      listingTitle,
      pushTitle: 'How was your stay?',
      pushBody: `Your stay at ${listingTitle} is complete — leave a review`,
      link: `/stays/${booking.listing_id}`,
    });
  }

  /** Batch entry point for the scheduler — finds every booking past its hold window and releases each. */
  async releaseExpiredHolds(): Promise<number> {
    const due = await this.bookingsRepo.find({
      where: { status: In(['checked_in', 'checked_out']), escrow_release_time: LessThanOrEqual(new Date()) },
      select: { id: true },
    });
    for (const row of due) {
      // One failing booking must not stop the rest of the batch.
      try {
        await this.releaseHold(row.id);
      } catch (err) {
        this.logger.error(`[releaseExpiredHolds] booking ${row.id} failed`, err as Error);
      }
    }
    if (due.length > 0) {
      this.logger.log(`[releaseExpiredHolds] released ${due.length} booking(s)`);
    }
    return due.length;
  }

  /**
   * The day a disputed stay really ends once it resolves. An early-departure
   * case uses the guest's chosen leaving date; any other dispute ends the
   * stay today (IST). Always clamped into [move_in, move_out] so a stay is
   * never extended and never ends before it began.
   */
  private resolvedStayEnd(moveIn: string, moveOut: string, disputeCase: DisputeCaseEntity): string {
    const wanted = disputeCase.leaving_on ? calendarDayNumber(disputeCase.leaving_on) : todayDayNumberIST();
    const end = Math.min(calendarDayNumber(moveOut), Math.max(calendarDayNumber(moveIn), isNaN(wanted) ? todayDayNumberIST() : wanted));
    return calendarDayToISO(end);
  }

  /**
   * Admin resolution of an escalated case, for any split — `amountToGuest`
   * of 0 or the full paid amount reproduces the old binary release/refund
   * exactly, but any value between is now expressible too. Either way the
   * booking's active life ends at `completed` — a dispute resolved in the
   * guest's full favour is still a completed stay, not a cancellation; the
   * distinction is only which side(s) the money lands on.
   */
  async resolveDispute(adminUserId: string, bookingId: string, amountToGuest: number, message: string | undefined) {
    const booking = await this.bookingsRepo.findOne({
      where: { id: bookingId },
      select: { status: true, guest_id: true, host_id: true, listing_id: true, move_in: true, move_out: true },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.status !== 'disputed') {
      throw new ConflictException(`Cannot resolve a booking in status "${booking.status}"`);
    }
    const disputeCase = await this.disputeCasesRepo.findOne({ where: { booking_id: bookingId } });
    if (!disputeCase || disputeCase.case_status !== 'escalated') {
      throw new ConflictException('This dispute is not awaiting admin review.');
    }

    await this.payments.splitRelease(bookingId, amountToGuest);

    const updateRes = await this.bookingsRepo.update(
      { id: bookingId, status: 'disputed' },
      { status: 'completed', actual_move_out: this.resolvedStayEnd(booking.move_in, booking.move_out, disputeCase), updated_at: new Date() },
    );
    if (updateRes.affected === 0) {
      throw new ConflictException('Booking status changed during operation');
    }
    await this.recordEvent(bookingId, 'disputed', 'completed', adminUserId);
    await this.disputeEventsRepo.insert({
      dispute_case_id: disputeCase.id,
      actor_id: adminUserId,
      actor_role: 'admin',
      event_type: 'admin_decision',
      offer_amount: amountToGuest,
      message: message ?? null,
    });
    await this.disputeCasesRepo.update(
      { id: disputeCase.id },
      { case_status: 'admin_decided', resolution_amount_to_guest: amountToGuest, resolved_by: 'admin', updated_at: new Date() },
    );

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';

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

  /**
   * Final say after one appeal — same shape as the original admin
   * decision, but only reachable once per case (dispute_cases.appeal_used)
   * and re-splits the payment that already "moved" on the first decision.
   * Simulated payments make that a plain overwrite; a real gateway
   * integration would need an actual reversal-then-reissue here instead.
   */
  async resolveAppeal(adminUserId: string, bookingId: string, amountToGuest: number, message: string | undefined) {
    const booking = await this.bookingsRepo.findOne({
      where: { id: bookingId },
      select: { guest_id: true, host_id: true, listing_id: true },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    const disputeCase = await this.disputeCasesRepo.findOne({ where: { booking_id: bookingId } });
    if (!disputeCase || disputeCase.case_status !== 'appealed') {
      throw new ConflictException('This dispute is not under appeal.');
    }

    await this.payments.splitRelease(bookingId, amountToGuest);
    await this.disputeEventsRepo.insert({
      dispute_case_id: disputeCase.id,
      actor_id: adminUserId,
      actor_role: 'admin',
      event_type: 'appeal_decision',
      offer_amount: amountToGuest,
      message: message ?? null,
    });
    await this.disputeCasesRepo.update(
      { id: disputeCase.id },
      { case_status: 'resolved', resolution_amount_to_guest: amountToGuest, resolved_by: 'appeal', updated_at: new Date() },
    );

    const listing = await this.listingsRepo.findOne({ where: { id: booking.listing_id }, select: { draft_data: true } });
    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
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

  /**
   * Manual checkout by guest or host.
   * Guest can checkout on or after the move_out date (India calendar day). Before
   * that there is no instant early checkout: leaving early goes through dispute()
   * (category early_departure), which keeps the payout hold until resolved.
   * Host can checkout strictly after the listing's checkOut time on the move_out date.
   */
  async checkout(userId: string, id: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: { status: true, guest_id: true, host_id: true, listing_id: true, move_out: true },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.guest_id !== userId && booking.host_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }
    if (booking.status !== 'checked_in') {
      throw new ConflictException(`Cannot checkout a booking in status "${booking.status}"`);
    }

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });

    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';
    const houseRules = (listing?.draft_data as any)?.house_rules;
    const checkoutTimeStr = houseRules?.check_out ?? houseRules?.checkOut ?? '11:00 AM';

    const now = new Date();
    const moveOutDate = calendarDayNumber(booking.move_out);
    const todayDate = todayDayNumber(now);

    const isGuest = booking.guest_id === userId;

    // TEST ONLY (CHECKOUT_DATE_BYPASS): skips the move-out date and checkout-time rules.
    const dateBypass = ['true', '1'].includes(String(this.config.get('CHECKOUT_DATE_BYPASS')));
    if (dateBypass) {
      this.logger.warn(`[checkout] date check bypassed for booking ${id} (CHECKOUT_DATE_BYPASS)`);
    }

    if (dateBypass) {
      // no date rules
    } else if (isGuest) {
      if (todayDayNumberIST(now) < moveOutDate) {
        throw new ConflictException(
          'You cannot check out before your move-out date. If you need to leave early or something is wrong with the stay, report it instead (choose "Leaving early" under Report a problem). There is no automatic refund for unused nights, and the payout stays on hold until the case is resolved.',
        );
      }
    } else {
      if (todayDate < moveOutDate) {
        throw new ConflictException('You cannot check out a guest before their move-out date.');
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

        if (currentHour < hours || (currentHour === hours && currentMinute < minutes)) {
          throw new ConflictException(`You can only check out the guest after the official checkout time (${checkoutTimeStr}).`);
        }
      }
    }

    const fromStatus = booking.status;
    const updateRes = await this.bookingsRepo.update(
      { id, status: fromStatus },
      { status: 'checked_out', checkout_time: now, updated_at: now },
    );
    if (updateRes.affected === 0) {
      throw new ConflictException('Booking status changed during operation');
    }
    await this.recordEvent(id, fromStatus, 'checked_out', userId);

    const otherParty = isGuest ? booking.host_id : booking.guest_id;
    const leftEarly = isGuest && todayDate < moveOutDate;
    const pushBody = leftEarly
      ? `Your guest has checked out early from ${listingTitle}`
      : isGuest
        ? `Your guest has checked out of ${listingTitle}`
        : `Your host has marked your stay at ${listingTitle} as completed`;

    this.notifications.notify(leftEarly ? 'booking.checked_out_early' : 'booking.checked_out', otherParty, {
      listingTitle,
      pushTitle: leftEarly ? 'Guest checked out early' : 'Stay completed',
      pushBody,
      link: isGuest ? '/host?tab=bookings' : `/stays/${booking.listing_id}`,
    });

    return { success: true, status: 'checked_out' as const };
  }
}
