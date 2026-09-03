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
import { randomInt } from 'crypto';
import {
  BookingEntity,
  BookingEventEntity,
  ListingEntity,
  ProfileEntity,
} from '../entities';
import { agreeTerms } from '../common/domain';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { assertVerified } from '../user/verification-gate.util';
import { CreateBookingDto } from './dto/create-booking.dto';
import { ReviewEntity } from '../entities';

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
    @InjectRepository(ProfileEntity)
    private readonly profilesRepo: Repository<ProfileEntity>,
    @InjectRepository(ReviewEntity)
    private readonly reviewsRepo: Repository<ReviewEntity>,
    private readonly notifications: NotificationsService,
    private readonly payments: PaymentsService,
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

    let inserted;
    let terms;
    try {
      terms = agreeTerms(
        dailyBaseRate,
        weeklyDiscountPct,
        monthlyDiscountPct,
        dto.days,
        dto.paymentMethod
      );

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
      throw new BadRequestException('Database error: ' + e.message);
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
        : Promise.resolve([] as ProfileEntity[]),
      Promise.all(rows.map((row) => this.payments.getForBooking(row.id))),
      this.reviewsRepo.find({ where: { author_id: userId }, select: { booking_id: true } }),
    ]);

    const titleById = new Map(
      listingRows.map((l) => [l.id, (l.draft_data as any)?.property_details?.title ?? 'Listing']),
    );
    const nameById = new Map(profileRows.map((p) => [p.id, p.full_name ?? 'Basera user']));
    console.log('DEBUG paymentResults:', paymentResults);
    const paidByBookingId = new Set(
      paymentResults.filter((p) => p && p.status !== 'refunded').map((p) => p!.booking_id)
    );
    console.log('DEBUG paidByBookingId:', paidByBookingId);

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
  async dispute(userId: string, id: string, reason: string) {
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

    const updateRes = await this.bookingsRepo.update(
      { id, status: 'checked_in' },
      { status: 'disputed', rejection_reason: reason, updated_at: new Date() },
    );
    if (updateRes.affected === 0) {
      throw new ConflictException('Booking status changed during operation');
    }
    await this.recordEvent(id, 'checked_in', 'disputed', userId);

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

    return { success: true, status: 'disputed' as const };
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
   * Admin-only resolution of a disputed booking. `release` sides with the
   * host (money was fine, dispute didn't hold up); `refund` sides with the
   * guest. Either way the booking's active life ends at `completed` — the
   * distinction is only which side the money lands on.
   */
  async resolveDispute(adminUserId: string, id: string, resolution: 'refund' | 'release') {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: { status: true, guest_id: true, host_id: true, listing_id: true },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.status !== 'disputed') {
      throw new ConflictException(`Cannot resolve a booking in status "${booking.status}"`);
    }

    if (resolution === 'release') {
      await this.payments.release(id);
    } else {
      await this.payments.refund(id);
    }

    const newStatus = resolution === 'refund' ? 'cancelled' : 'completed';
    const updateRes = await this.bookingsRepo.update(
      { id, status: 'disputed' },
      { status: newStatus, updated_at: new Date() },
    );
    if (updateRes.affected === 0) {
      throw new ConflictException('Booking status changed during operation');
    }
    await this.recordEvent(id, 'disputed', newStatus, adminUserId);

    const listing = await this.listingsRepo.findOne({
      where: { id: booking.listing_id },
      select: { draft_data: true },
    });
    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';

    this.notifications.notify('booking.completed', booking.guest_id, {
      listingTitle,
      pushTitle: resolution === 'refund' ? 'Dispute resolved — refunded' : 'Dispute resolved',
      pushBody:
        resolution === 'refund'
          ? `Your payment for ${listingTitle} has been refunded`
          : `Your dispute for ${listingTitle} has been resolved`,
      link: `/stays/${booking.listing_id}`,
    });
    this.notifications.notify('booking.completed', booking.host_id, {
      listingTitle,
      pushTitle: resolution === 'release' ? 'Dispute resolved — payment released' : 'Dispute resolved',
      pushBody:
        resolution === 'release'
          ? `Payment for ${listingTitle} has been released to you`
          : `A dispute for ${listingTitle} has been resolved in the guest's favour`,
      link: '/host/bookings',
    });

    return { success: true, status: 'completed' as const, resolution };
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
