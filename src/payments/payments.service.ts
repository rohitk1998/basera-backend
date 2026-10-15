import { ConflictException, Injectable, InternalServerErrorException, Inject } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository, DataSource, In, QueryFailedError } from 'typeorm';
import { PaymentEntity } from '../entities';

// Postgres unique_violation — see idx_payments_booking_id in
// migrations/20260922_payments_booking_id_unique.sql.
const PG_UNIQUE_VIOLATION = '23505';

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

  /** Mocked Cashfree Easy Split payload — no real Cashfree call, no real
   *  SDK. Follows the same SIMULATED-{uuid} convention as
   *  cashfree_order_id/cashfree_payout_id here. There is no
   *  concept yet of a host's real Cashfree vendor id anywhere in the
   *  schema, so `vendor_id` is a mocked placeholder derived from the host's
   *  own id rather than a new column.
   *
   *  `hostPayoutAmount` is passed straight through as the split amount —
   *  never reduced further here for a gateway/UPI fee. bookings.service.ts
   *  create() already computed the final host payout (gross - commission);
   *  this method must not re-derive or shrink it. */
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

  /** Throws ConflictException, not a raw DB error, if a payment for this
   *  booking already exists — the unique index on booking_id
   *  (migrations/20260922_payments_booking_id_unique.sql) is what actually
   *  closes the race two concurrent pay() calls could otherwise hit; this
   *  just turns that constraint violation into the same exception type the
   *  application-level "already paid" check in bookings.service.ts already
   *  throws, so callers don't need to special-case which layer caught it. */
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

  async getForBooking(bookingId: string): Promise<PaymentEntity | null> {
    return this.paymentsRepo.findOne({ where: { booking_id: bookingId } });
  }

  /** Batched form of `getForBooking` for list views — one query instead of
   *  one per booking. Returns a map keyed by `booking_id` so callers can
   *  look up per-row without re-scanning the result array. */
  async getForBookings(bookingIds: string[]): Promise<Map<string, PaymentEntity>> {
    if (bookingIds.length === 0) return new Map();
    const rows = await this.paymentsRepo.find({ where: { booking_id: In(bookingIds) } });
    return new Map(rows.map((row) => [row.booking_id, row]));
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

    qb.orderBy('payment.created_at', 'DESC');

    const results = await qb.getRawMany();

    return {
      success: true,
      transactions: results.map((row) => ({
        id: row.id,
        amount: row.amount,
        status: row.status,
        // Only for `split`: what the guest got back, and what the host was paid.
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
