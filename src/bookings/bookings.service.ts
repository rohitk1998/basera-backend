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
import { CashfreeService } from '../payments/cashfree.service';
import { PaymentsService } from '../payments/payments.service';
import { SupabaseProvider } from '../auth/supabase.provider';
import { assertKycVerified } from '../user/verification-gate.util';
import { CreateBookingDto } from './dto/create-booking.dto';
import { DisputeBookingDto } from './dto/dispute-booking.dto';
import { ReviewEntity, DisputeCaseEntity, DisputeEventEntity, VerificationRequestEntity } from '../entities';

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

const NEGOTIATION_ROUNDS_CAP = 3;
const NEGOTIATION_STALE_HOURS = 48;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const CHECKIN_MAX_FAILED_ATTEMPTS = 5;
const CHECKIN_LOCKOUT_MS = 15 * 60 * 1000;

const ESCROW_HOLD_HOURS = 5 / 60;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toIndianMobile(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(local) ? local : null;
}

function generateCheckinCode(): string {
  return String(randomInt(0, 10000)).padStart(4, '0');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
    private readonly cashfree: CashfreeService,
  ) { }

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
    assertKycVerified(requestingProfile, { identity: { status: latestIdentity?.status ?? 'not_started' } });

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
        months: dto.days,
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
        .filter((p) => (PaymentsService.PAID_STATUSES as readonly string[]).includes(p.status))
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
      escrowReleaseTime: row.escrow_release_time,
      rejectionReason: row.rejection_reason,
      isPaid: paidByBookingId.has(row.id),
      hasReviewed: reviewsRows ? reviewsRows.some((r) => r.booking_id === row.id) : false,
      counterpartName: nameById.get(role === 'host' ? row.guest_id : row.host_id) ?? 'Basera user',
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
      checkinCode: row.host_id === userId ? row.checkin_code : null,
      checkinTime: row.checkin_time,
      escrowReleaseTime: row.escrow_release_time,
      paymentStatus: payment?.status ?? null,
    };

    return { success: true, booking };
  }

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

    await this.payments.markFailed(id);

    return { success: true, status: 'cancelled' as const };
  }

  async pay(userId: string, id: string) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: {
        status: true,
        guest_id: true,
        host_id: true,
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
    if (booking.status !== 'confirmed') {
      throw new ConflictException(`Cannot pay for a booking in status "${booking.status}"`);
    }

    const existing = await this.payments.getForBooking(id);
    if (existing && existing.status !== 'pending' && existing.status !== 'failed') {
      throw new ConflictException('This booking has already been paid for.');
    }

    let attempt = 1;
    if (existing) {
      const order = await this.cashfree.fetchPgOrder(existing.cashfree_order_id);
      if (order?.status === 'PAID') {
        await this.syncPayment(id);
        return { success: true, status: 'confirmed' as const, paid: true as const };
      }
      if (existing.status === 'pending' && order?.status === 'ACTIVE' && order.paymentSessionId) {
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
      throw new BadRequestException('Add a mobile number to your profile before paying.');
    }

    const orderId = `bk_${id.replace(/-/g, '')}_${attempt}`;
    const order = await this.cashfree.createPgOrder({
      orderId,
      amount: booking.due_at_move_in,
      customerId: userId,
      customerPhone: phone,
      ...(guest?.email && EMAIL_SHAPE.test(guest.email) ? { customerEmail: guest.email } : {}),
      returnUrl: `${this.appUrl()}/booking/confirmed?booking=${id}&order_id={order_id}`,
      notifyUrl: this.webhookUrl(),
    });
    if (!order.paymentSessionId) {
      throw new InternalServerErrorException('Payment service returned no checkout session');
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
    if (!base.startsWith('https://') || /localhost|127\.0\.0\.1/.test(base)) return undefined;
    return `${base}/api/payments/cashfree/webhook`;
  }

  async syncPayment(bookingId: string): Promise<'held' | 'pending' | 'failed' | 'none'> {
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
      const cfPaymentId = await this.cashfree.fetchSuccessfulPaymentId(order.orderId);
      if (await this.payments.markHeld(bookingId, cfPaymentId)) {
        await this.onPaymentHeld(bookingId);
      }
      return 'held';
    }
    if (order.status === 'EXPIRED' || order.status === 'TERMINATED' || order.status === 'TERMINATION_REQUESTED') {
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
    if (booking.status !== 'confirmed') {
      this.logger.error(
        `Booking ${bookingId} was paid while in status "${booking.status}" — payment is held, needs a manual refund`,
      );
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
    const listingTitle = (listing?.draft_data as any)?.property_details?.title ?? 'the listing';

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
      pushBody: `Your payment for ${listingTitle} is held by Basera until 24 hours after check-in`,
      link: '/settings?tab=bookings',
    });

    this.notifications.notify('booking.checkin_code_ready', booking.host_id, {
      listingTitle,
      pushTitle: 'Check-in code ready',
      pushBody: `Your guest's check-in code for ${listingTitle} is ready — give it to them in person on arrival`,
      link: '/host?tab=bookings',
    });
  }

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
    const requestedAmount = dto.requestedAmount ?? 0;
    if (payment && requestedAmount > payment.amount) {
      throw new BadRequestException('Requested amount cannot exceed the amount paid.');
    }

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

  async getDisputeCase(userId: string, bookingId: string) {
    const { disputeCase, viewerRole } = await this.requireDisputeCase(userId, bookingId);
    return { success: true, viewerRole, ...(await this.loadDisputeTimeline(disputeCase)) };
  }

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
    const lastOfferRole = lastEvent?.event_type === 'claim_raised' ? null : lastEvent?.actor_role ?? null;
    if (lastOfferRole === viewerRole) {
      throw new ConflictException('Waiting on the other party — not your turn to offer.');
    }
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

  private notifyDisputeEscalated(booking: { guest_id: string; host_id: string }, listingTitle: string): void {
    this.notifications.notify('dispute.escalated', booking.guest_id, { listingTitle, link: '/settings?tab=bookings' });
    this.notifications.notify('dispute.escalated', booking.host_id, { listingTitle, link: '/host?tab=bookings' });
  }

  private async disputeAmounts(bookingId: string, amountToGuest: number) {
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

  async releaseHold(id: string): Promise<void> {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      select: { status: true, guest_id: true, host_id: true, listing_id: true },
    });
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

  async releaseExpiredHolds(): Promise<number> {
    const due = await this.bookingsRepo.find({
      where: { status: In(['checked_in', 'checked_out']), escrow_release_time: LessThanOrEqual(new Date()) },
      select: { id: true },
    });
    for (const row of due) {
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

  private resolvedStayEnd(moveIn: string, moveOut: string, disputeCase: DisputeCaseEntity): string {
    const wanted = disputeCase.leaving_on ? calendarDayNumber(disputeCase.leaving_on) : todayDayNumberIST();
    const end = Math.min(calendarDayNumber(moveOut), Math.max(calendarDayNumber(moveIn), isNaN(wanted) ? todayDayNumberIST() : wanted));
    return calendarDayToISO(end);
  }

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

    const dateBypass = ['true', '1'].includes(String(this.config.get('CHECKOUT_DATE_BYPASS')));
    if (dateBypass) {
      this.logger.warn(`[checkout] date check bypassed for booking ${id} (CHECKOUT_DATE_BYPASS)`);
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
