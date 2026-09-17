import { Injectable, InternalServerErrorException, Inject } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository, DataSource } from 'typeorm';
import { PaymentEntity } from '../entities';

/**
 * Phase 1 — DB-level simulation only, no real Cashfree/Razorpay call.
 * `cashfree_order_id`/`cashfree_payout_id` are `not null`/nullable real
 * columns from the existing migration, so every simulated value is
 * prefixed `SIMULATED-` — greppable (`LIKE 'SIMULATED-%'`), and an
 * unambiguous seam for the future real gateway integration to backfill
 * or ignore.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(PaymentEntity)
    private readonly paymentsRepo: Repository<PaymentEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async createHeldPayment(bookingId: string, amount: number): Promise<PaymentEntity> {
    const payment = this.paymentsRepo.create({
      booking_id: bookingId,
      amount,
      cashfree_order_id: `SIMULATED-${randomUUID()}`,
      cashfree_payout_id: null,
      status: 'held',
    });
    return this.paymentsRepo.save(payment);
  }

  async getForBooking(bookingId: string): Promise<PaymentEntity | null> {
    return this.paymentsRepo.findOne({ where: { booking_id: bookingId } });
  }

  /** `held` → `released_to_host`. Called by the auto-release scheduler or an admin dispute resolution. */
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

  /** `held` → `refunded`. Only reached via admin dispute resolution in favour of the guest. */
  async refund(bookingId: string): Promise<void> {
    const payment = await this.getForBooking(bookingId);
    if (!payment || payment.status !== 'held') {
      throw new InternalServerErrorException(`No held payment found for booking ${bookingId}`);
    }
    await this.paymentsRepo.update({ id: payment.id }, { status: 'refunded', updated_at: new Date() });
  }

  /**
   * The one payout path for a dispute settling on some split between guest
   * and host — an accepted negotiation, an admin decision, or an appeal
   * decision. `amountToGuest` of 0 or the full amount reproduces `release`/
   * `refund` exactly, but is still recorded as `split` rather than reusing
   * those two statuses, so a resolved dispute is always distinguishable
   * from the plain auto-release/binary-resolve paths in the payments log.
   *
   * Re-callable on an already-`split`/`released_to_host`/`refunded` payment
   * — an appeal needs to adjust an amount that already "moved". Since every
   * payout here is simulated (no real gateway call), that's just an
   * overwrite, not a reversal-then-reissue. A real gateway integration
   * cannot re-split a payout already sent and would need an actual
   * reversal-then-reissue flow at that point — noted here, not built now.
   */
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
        'payment.cashfree_order_id AS "cashfreeOrderId"',
        'payment.cashfree_payout_id AS "cashfreePayoutId"',
        'payment.created_at AS "createdAt"',
        'payment.updated_at AS "updatedAt"',
        'booking.id AS "bookingId"',
        'booking.move_in AS "moveIn"',
        'booking.move_out AS "moveOut"',
        "listing.draft_data->'property_details'->>'title' AS \"listingTitle\"",
      ]);

    if (role === 'guest') {
      qb.where('booking.guest_id = :userId', { userId });
    } else if (role === 'host') {
      qb.where('booking.host_id = :userId', { userId });
    } else {
      qb.where('(booking.guest_id = :userId OR booking.host_id = :userId)', { userId });
    }

    qb.orderBy('payment.created_at', 'DESC');

    const results = await qb.getRawMany();

    return {
      success: true,
      transactions: results.map((row) => ({
        id: row.id,
        amount: row.amount,
        status: row.status,
        cashfreeOrderId: row.cashfreeOrderId,
        cashfreePayoutId: row.cashfreePayoutId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        bookingId: row.bookingId,
        moveIn: row.moveIn,
        moveOut: row.moveOut,
        listingTitle: row.listingTitle || 'Listing',
      })),
    };
  }
}
