import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { randomInt, randomUUID } from 'crypto';
import {
  BookingEntity,
  BookingEventEntity,
  ListingEntity,
  UserEntity,
} from '../entities';
import { agreeTerms } from '../common/domain';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { SupabaseProvider } from '../auth/supabase.provider';
import { assertVerified } from '../user/verification-gate.util';
import { CreateBookingDto } from './dto/create-booking.dto';
import { DisputeBookingDto } from './dto/dispute-booking.dto';
import { ReviewEntity, DisputeCaseEntity, DisputeEventEntity } from '../entities';

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
/** A negotiating case with no reply in this long auto-escalates to admin —
 *  piggybacks on the existing release-scheduler's cron tick rather than
 *  standing up a second scheduler for one query. */
const NEGOTIATION_STALE_HOURS = 48;
/** No human actor for an auto-escalated dispute_events row — actor_id has
 *  no FK (unlike booking_events.actor, which does, to profiles), but a
 *  real-looking-but-fake uuid would be misleading in the data; the
 *  all-zeros nil UUID reads unambiguously as "not a real user" instead. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

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
  ) { }

  private async recordEvent(
    bookingId: string,
    fromStatus: string | null,
    toStatus: string,
    actor: string,
  ): Promise<void> {
    await this.bookingEventsRepo.insert({
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

    const requestingProfile = { id: userId, kyc_completed_at: new Date(), selfie_uploaded_at: new Date(), bank_verified_at: new Date() };
    // The gate is for the person, not the API — same principle as
    // host-listings.service.ts submitFull(). Guests never need
    // kyc_completed_at (that's host-only HP Tourism/PAN verification).
    assertVerified(requestingProfile, { requireHostKyc: false });

    const moveInDate = new Date(dto.moveIn);
    const moveOutDate = new Date(dto.moveOut);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (isNaN(moveInDate.getTime()) || isNaN(moveOutDate.getTime())) {
      throw new BadRequestException('Invalid date format.');
    }
    if (moveInDate < today) {
      throw new BadRequestException('Move-in date cannot be in the past.');
    }
    if (moveOutDate <= moveInDate) {
      throw new BadRequestException('Move-out date must be after move-in date.');
    }

    const overlapping = await this.bookingsRepo
      .createQueryBuilder('b')
      .where('b.listing_id = :listingId', { listingId: dto.listingId })
      .andWhere('b.status IN (:...statuses)', { statuses: ['confirmed', 'approved', 'checked_in', 'completed', 'checked_out'] })
      .andWhere('b.move_in < :moveOut', { moveOut: dto.moveOut })
      .andWhere('b.move_out > :moveIn', { moveIn: dto.moveIn })
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

    const weeklyDiscountPct = propertyDetails.weeklyDiscountPct || 15;
    const monthlyDiscountPct = propertyDetails.monthlyDiscountPct || 40;

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
        monthly_rent: terms.totalRent, // Storing total rent in the legacy "monthly_rent" column
        deposit: terms.deposit,
        payment_method: terms.paymentMethod,
        due_at_move_in: terms.dueAtMoveIn,
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
      link: '/host/bookings',
    });

    return { success: true, id: bookingId, status: 'requested' as const };
  }

  /**
   * The caller's own bookings, as guest or host. Rows are flattened with the
   * listing title read out of `draft_data` here rather than handed back raw.
   */
  async list(userId: string, role: 'host' | 'guest') {
    const rows = await this.bookingsRepo.find({
      where: role === 'host' ? { host_id: userId } : { guest_id: userId },
      order: { created_at: 'DESC' },
    });

    const listingIds = Array.from(new Set(rows.map((r) => r.listing_id)));
    const counterpartIds = Array.from(
      new Set(rows.map((r) => (role === 'host' ? r.guest_id : r.host_id))),
    );

    const [listingRows, profileRows, paymentResults, reviewsRows] = await Promise.all([
      listingIds.length
        ? this.listingsRepo.find({ where: listingIds.map((id) => ({ id })), select: { id: true, draft_data: true } })
        : Promise.resolve([] as ListingEntity[]),
      counterpartIds.length
        ? this.profilesRepo.find({ where: counterpartIds.map((id) => ({ id })), select: { id: true, full_name: true } })
        : Promise.resolve([] as UserEntity[]),
      Promise.all(rows.map((row) => this.payments.getForBooking(row.id))),
      this.reviewsRepo.find({ where: { author_id: userId }, select: { booking_id: true } }),
    ]);

    const titleById = new Map(
      listingRows.map((l) => [l.id, (l.draft_data as any)?.property_details?.title ?? 'Listing']),
    );
    const nameById = new Map(profileRows.map((p) => [p.id, p.full_name ?? 'Basera user']));
    const paidByBookingId = new Set(
      paymentResults.filter((p) => p && p.status !== 'refunded').map((p) => p!.booking_id)
    );

    const bookings = rows.map((row) => ({
      id: row.id,
      listingId: row.listing_id,
      listingTitle: titleById.get(row.listing_id) ?? 'Listing',
      status: row.status,
      moveIn: row.move_in,
      moveOut: row.move_out,
      days: row.months,
      totalRent: row.monthly_rent,
      deposit: row.deposit,
      paymentMethod: row.payment_method as 'upi' | 'cash',
      dueAtMoveIn: row.due_at_move_in,
      checkinCode: row.checkin_code,
      checkinTime: row.checkin_time,
      escrowReleaseTime: row.escrow_release_time,
      rejectionReason: row.rejection_reason,
      isPaid: paidByBookingId.has(row.id),
      hasReviewed: reviewsRows ? reviewsRows.some((r) => r.booking_id === row.id) : false,
      counterpartName: nameById.get(role === 'host' ? row.guest_id : row.host_id) ?? 'Basera user',
      createdAt: row.created_at,
    }));

    return { success: true, bookings };
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
      days: row.months,
      totalRent: row.monthly_rent,
      deposit: row.deposit,
      paymentMethod: row.payment_method as 'upi' | 'cash',
      dueAtMoveIn: row.due_at_move_in,
      rejectionReason: row.rejection_reason,
      checkinCode: row.checkin_code,
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
   * Also generates the check-in OTP here, for the HOST — this is the
   * physical-presence check: the guest can only learn the code by actually
   * showing up and getting it from the host in person, and it's the guest
   * who submits it back (see checkin()) to prove they reached the property.
   */
  async approve(userId: string, id: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: { status: true, host_id: true, guest_id: true, listing_id: true, move_in: true, checkin_code: true },
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

    const checkinCode = booking.checkin_code ?? generateCheckinCode();

    const updateRes = await this.bookingsRepo.update(
      { id, status: 'requested' },
      { status: 'confirmed', checkin_code: checkinCode, updated_at: new Date() },
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
      pushTitle: 'Booking confirmed',
      pushBody: `${hostName} confirmed your stay at ${listingTitle}`,
      link: '/messages',
    });

    // Host-only notification carrying the OTP — never sent to the guest.
    this.notifications.notify('booking.checkin_code_ready', booking.host_id, {
      listingTitle,
      checkinCode,
      pushTitle: 'Check-in code ready',
      pushBody: `Your guest's check-in code for ${listingTitle} is ${checkinCode} — give it to them in person on arrival`,
      link: '/host/bookings',
    });

    return { success: true, status: 'confirmed' as const, checkinCode };
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
      link: userId === booking.guest_id ? '/host/bookings' : '/stays',
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
      select: { status: true, guest_id: true, host_id: true, listing_id: true, due_at_move_in: true },
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

    await this.payments.createHeldPayment(id, booking.due_at_move_in);

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';

    this.notifications.notify('booking.payment_held', booking.host_id, {
      listingTitle,
      pushTitle: 'Payment received and held',
      pushBody: `Payment for ${listingTitle} is held — your guest is on their way`,
      link: '/host/bookings',
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
      select: { status: true, guest_id: true, host_id: true, listing_id: true, checkin_code: true },
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
    if (!booking.checkin_code || booking.checkin_code !== code) {
      throw new BadRequestException('That check-in code is incorrect.');
    }

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
      link: '/host/bookings',
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
      select: { status: true, guest_id: true, host_id: true, listing_id: true, escrow_release_time: true },
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
    if (booking.escrow_release_time && booking.escrow_release_time.getTime() <= Date.now()) {
      throw new ConflictException('The dispute window for this booking has closed.');
    }

    const payment = await this.payments.getForBooking(id);
    if (payment && dto.requestedAmount > payment.amount) {
      throw new BadRequestException('Requested amount cannot exceed the amount paid.');
    }

    const updateRes = await this.bookingsRepo.update(
      { id, status: 'checked_in' },
      { status: 'disputed', updated_at: new Date() },
    );
    if (updateRes.affected === 0) {
      throw new ConflictException('Booking status changed during operation');
    }
    await this.recordEvent(id, 'checked_in', 'disputed', userId);

    const disputeCase = await this.disputeCasesRepo.save(
      this.disputeCasesRepo.create({
        booking_id: id,
        category: dto.category,
        description: dto.description,
        requested_amount: dto.requestedAmount,
        evidence_urls: [],
        case_status: 'open',
      }),
    );
    await this.disputeEventsRepo.insert({
      dispute_case_id: disputeCase.id,
      actor_id: userId,
      actor_role: 'guest',
      event_type: 'claim_raised',
      offer_amount: dto.requestedAmount,
      message: dto.description,
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
      link: '/host/bookings',
    });

    return { success: true, status: 'disputed' as const, disputeCaseId: disputeCase.id };
  }

  /** Guest or host of the booking only. Backs the case panel both sides
   *  see, and the evidence-add/offer/respond/appeal endpoints' own guards. */
  private async requireDisputeCase(userId: string, bookingId: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id: bookingId },
      select: { guest_id: true, host_id: true, listing_id: true },
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
    const events = await this.disputeEventsRepo.find({
      where: { dispute_case_id: disputeCase.id },
      order: { created_at: 'ASC' },
    });
    return { success: true, viewerRole, case: disputeCase, events };
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
        throw new BadRequestException({ error: 'File too large. Maximum size is 5 MB.', statusCode: 413 });
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
      link: viewerRole === 'host' ? '/account/transactions' : '/host/bookings',
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
      await this.bookingsRepo.update({ id: bookingId, status: 'disputed' }, { status: 'completed', updated_at: new Date() });
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
      this.notifications.notify('booking.completed', otherParty, {
        listingTitle,
        pushTitle: 'Dispute resolved',
        pushBody: `The dispute for ${listingTitle} was settled directly between you and the other party`,
        link: viewerRole === 'guest' ? '/host/bookings' : `/stays/${booking.listing_id}`,
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
    this.notifications.notify('dispute.escalated', booking.guest_id === userId ? booking.host_id : booking.guest_id, {
      listingTitle,
      link: '/host/bookings',
    });

    return { success: true, caseStatus: 'escalated' as const };
  }

  /** A negotiating case with no activity in NEGOTIATION_STALE_HOURS forces
   *  to admin — called from the same cron tick as releaseExpiredHolds
   *  rather than a second scheduler for one query. */
  async escalateStaleNegotiations(): Promise<number> {
    const staleBefore = new Date(Date.now() - NEGOTIATION_STALE_HOURS * 60 * 60 * 1000);
    const stale = await this.disputeCasesRepo.find({
      where: { case_status: 'negotiating' },
      select: { id: true, updated_at: true },
    });
    const due = stale.filter((c) => c.updated_at <= staleBefore);
    for (const c of due) {
      await this.disputeEventsRepo.insert({
        dispute_case_id: c.id,
        actor_id: NIL_UUID,
        actor_role: 'system',
        event_type: 'escalated',
        message: 'Auto-escalated after no activity',
      });
      await this.disputeCasesRepo.update({ id: c.id }, { case_status: 'escalated', updated_at: new Date() });
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
      link: '/host/bookings',
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
    if (!booking || booking.status !== 'checked_in') {
      return;
    }

    await this.payments.release(id);

    const updateRes = await this.bookingsRepo.update(
      { id, status: 'checked_in' },
      { status: 'completed', updated_at: new Date() },
    );
    if (updateRes.affected === 0) {
      this.logger.warn(`[releaseHold] booking ${id} status changed during release`);
      return;
    }
    await this.recordEvent(id, 'checked_in', 'completed', 'system');

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
      where: { status: 'checked_in', escrow_release_time: LessThanOrEqual(new Date()) },
      select: { id: true },
    });
    for (const row of due) {
      await this.releaseHold(row.id);
    }
    if (due.length > 0) {
      this.logger.log(`[releaseExpiredHolds] released ${due.length} booking(s)`);
    }
    return due.length;
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
      select: { status: true, guest_id: true, host_id: true, listing_id: true },
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
      { status: 'completed', updated_at: new Date() },
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

    this.notifications.notify('booking.completed', booking.guest_id, {
      listingTitle,
      pushTitle: 'Dispute resolved',
      pushBody: `Basera has resolved your dispute for ${listingTitle}`,
      link: `/stays/${booking.listing_id}`,
    });
    this.notifications.notify('booking.completed', booking.host_id, {
      listingTitle,
      pushTitle: 'Dispute resolved',
      pushBody: `Basera has resolved the dispute for ${listingTitle}`,
      link: '/host/bookings',
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
    this.notifications.notify('booking.completed', booking.guest_id, {
      listingTitle,
      pushTitle: 'Appeal decided',
      pushBody: `Basera has made a final decision on the appeal for ${listingTitle}`,
      link: `/stays/${booking.listing_id}`,
    });
    this.notifications.notify('booking.completed', booking.host_id, {
      listingTitle,
      pushTitle: 'Appeal decided',
      pushBody: `Basera has made a final decision on the appeal for ${listingTitle}`,
      link: '/host/bookings',
    });

    return { success: true, status: 'resolved' as const, amountToGuest };
  }

  /**
   * Manual checkout by guest or host.
   * Guest can checkout anytime on their move_out date.
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
    if (booking.status !== 'checked_in' && booking.status !== 'completed') {
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
    const moveOutDate = new Date(booking.move_out);
    moveOutDate.setHours(0, 0, 0, 0);

    const todayDate = new Date(now);
    todayDate.setHours(0, 0, 0, 0);

    const isGuest = booking.guest_id === userId;

    if (isGuest) {
      if (todayDate < moveOutDate) {
        throw new ConflictException('You can only check out on or after your official move-out date.');
      }
    } else {
      if (todayDate < moveOutDate) {
        throw new ConflictException('You cannot check out a guest before their move-out date.');
      }

      if (todayDate.getTime() === moveOutDate.getTime()) {
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
    const pushBody = isGuest
      ? `Your guest has checked out of ${listingTitle}`
      : `Your host has marked your stay at ${listingTitle} as completed`;

    this.notifications.notify('booking.checked_out', otherParty, {
      listingTitle,
      pushTitle: 'Stay completed',
      pushBody,
      link: isGuest ? '/host/bookings' : `/stays/${booking.listing_id}`,
    });

    return { success: true, status: 'checked_out' as const };
  }
}
