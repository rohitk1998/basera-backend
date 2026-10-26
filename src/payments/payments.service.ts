import { ConflictException, Injectable, InternalServerErrorException, Inject } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository, DataSource, In, QueryFailedError } from 'typeorm';
import { PaymentEntity } from '../entities';

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(PaymentEntity)
    private readonly paymentsRepo: Repository<PaymentEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  buildMockedSplitPayload(
    hostId: string,
    hostPayoutAmount: number,
    platformCommission: number,
  ): PaymentEntity['cashfree_split_payload'] {
    return {
      cashfree_split_order_id: `SIMULATED-${randomUUID()}`,
      splits: [{ vendor_id: `SIMULATED-VENDOR-${hostId}`, amount: hostPayoutAmount }],
      platform_amount: platformCommission,
    };
  }

  async createHeldPayment(
    bookingId: string,
    amount: number,
    split: { hostId: string; hostPayoutAmount: number; platformCommission: number },
  ): Promise<PaymentEntity> {
    const payment = this.paymentsRepo.create({
      booking_id: bookingId,
      amount,
      cashfree_order_id: `SIMULATED-${randomUUID()}`,
      cashfree_payout_id: null,
      status: 'held',
      cashfree_split_payload: this.buildMockedSplitPayload(
        split.hostId,
        split.hostPayoutAmount,
        split.platformCommission,
      ),
    });
    try {
      return await this.paymentsRepo.save(payment);
    } catch (err) {
      if (err instanceof QueryFailedError && (err as any).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException('This booking has already been paid for.');
      }
      throw err;
    }
  }

  static readonly PAID_STATUSES = ['held', 'released_to_host', 'split'] as const;

  async createPending(
    bookingId: string,
    amount: number,
    orderId: string,
    split: { hostId: string; hostPayoutAmount: number; platformCommission: number },
  ): Promise<PaymentEntity> {
    const payment = this.paymentsRepo.create({
      booking_id: bookingId,
      amount,
      cashfree_order_id: orderId,
      cashfree_payout_id: null,
      status: 'pending',
      attempt: 1,
      cashfree_split_payload: this.buildMockedSplitPayload(
        split.hostId,
        split.hostPayoutAmount,
        split.platformCommission,
      ),
    });
    try {
      return await this.paymentsRepo.save(payment);
    } catch (err) {
      if (err instanceof QueryFailedError && (err as any).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException('A payment for this booking is already in progress.');
      }
      throw err;
    }
  }

  async replaceOrder(bookingId: string, orderId: string, attempt: number): Promise<void> {
    await this.paymentsRepo.update(
      { booking_id: bookingId, status: In(['pending', 'failed']) },
      { cashfree_order_id: orderId, attempt, status: 'pending', updated_at: new Date() },
    );
  }

  async markHeld(bookingId: string, cfPaymentId: string | null): Promise<boolean> {
    const result = await this.paymentsRepo.update(
      { booking_id: bookingId, status: 'pending' },
      { status: 'held', cf_payment_id: cfPaymentId, paid_at: new Date(), updated_at: new Date() },
    );
    return (result.affected ?? 0) > 0;
  }

  async markFailed(bookingId: string): Promise<void> {
    await this.paymentsRepo.update(
      { booking_id: bookingId, status: 'pending' },
      { status: 'failed', updated_at: new Date() },
    );
  }

  async getByOrderId(orderId: string): Promise<PaymentEntity | null> {
    return this.paymentsRepo.findOne({ where: { cashfree_order_id: orderId } });
  }

  async getForBooking(bookingId: string): Promise<PaymentEntity | null> {
    return this.paymentsRepo.findOne({ where: { booking_id: bookingId } });
  }

  async getForBookings(bookingIds: string[]): Promise<Map<string, PaymentEntity>> {
    if (bookingIds.length === 0) return new Map();
    const rows = await this.paymentsRepo.find({ where: { booking_id: In(bookingIds) } });
    return new Map(rows.map((row) => [row.booking_id, row]));
  }

  async release(bookingId: string): Promise<void> {
    const payment = await this.getForBooking(bookingId);
    if (!payment || payment.status !== 'held') {
      throw new InternalServerErrorException(`No held payment found for booking ${bookingId}`);
    }
    await this.paymentsRepo.update(
      { id: payment.id },
      { status: 'released_to_host', cashfree_payout_id: `SIMULATED-${randomUUID()}`, updated_at: new Date() },
    );
  }

  async refund(bookingId: string): Promise<void> {
    const payment = await this.getForBooking(bookingId);
    if (!payment || payment.status !== 'held') {
      throw new InternalServerErrorException(`No held payment found for booking ${bookingId}`);
    }
    await this.paymentsRepo.update({ id: payment.id }, { status: 'refunded', updated_at: new Date() });
  }

  async splitRelease(bookingId: string, amountToGuest: number): Promise<void> {
    const payment = await this.getForBooking(bookingId);
    if (!payment) {
      throw new InternalServerErrorException(`No payment found for booking ${bookingId}`);
    }
    if (amountToGuest < 0 || amountToGuest > payment.amount) {
      throw new InternalServerErrorException('amountToGuest must be between 0 and the held amount');
    }
    await this.paymentsRepo.update(
      { id: payment.id },
      {
        status: 'split',
        split_amount_to_guest: amountToGuest,
        cashfree_payout_id: `SIMULATED-${randomUUID()}`,
        updated_at: new Date(),
      },
    );
  }

  async listTransactions(userId: string, role?: 'guest' | 'host') {
    const qb = this.dataSource
      .createQueryBuilder(PaymentEntity, 'payment')
      .innerJoin('bookings', 'booking', 'booking.id = payment.booking_id')
      .leftJoin('listings', 'listing', 'listing.id = booking.listing_id')
      .select([
        'payment.id AS id',
        'payment.amount AS amount',
        'payment.status AS status',
        'payment.split_amount_to_guest AS "splitAmountToGuest"',
        'payment.cashfree_order_id AS "cashfreeOrderId"',
        'payment.cashfree_payout_id AS "cashfreePayoutId"',
        'payment.created_at AS "createdAt"',
        'payment.updated_at AS "updatedAt"',
        'booking.id AS "bookingId"',
        'booking.move_in AS "moveIn"',
        'booking.move_out AS "moveOut"',
        'booking.actual_move_out AS "actualMoveOut"',
        "listing.draft_data->'property_details'->>'title' AS \"listingTitle\"",
      ]);

    if (role === 'guest') {
      qb.where('booking.guest_id = :userId', { userId });
    } else if (role === 'host') {
      qb.where('booking.host_id = :userId', { userId });
    } else {
      qb.where('(booking.guest_id = :userId OR booking.host_id = :userId)', { userId });
    }

    qb.andWhere('payment.status NOT IN (:...unpaid)', { unpaid: ['pending', 'failed'] });

    qb.orderBy('payment.created_at', 'DESC');

    const results = await qb.getRawMany();

    return {
      success: true,
      transactions: results.map((row) => ({
        id: row.id,
        amount: row.amount,
        status: row.status,
        refundedAmount: row.status === 'split' ? row.splitAmountToGuest : null,
        hostAmount: row.status === 'split' ? row.amount - row.splitAmountToGuest : null,
        cashfreeOrderId: row.cashfreeOrderId,
        cashfreePayoutId: row.cashfreePayoutId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        bookingId: row.bookingId,
        moveIn: row.moveIn,
        moveOut: row.moveOut,
        actualMoveOut: row.actualMoveOut,
        listingTitle: row.listingTitle || 'Listing',
      })),
    };
  }
}
