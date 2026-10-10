import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('payments')
export class PaymentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Sole predicate on getForBooking/getForBookings — see
  // migrations/20260921_perf_indexes.sql for the index. Unique, not just
  // indexed: a booking has at most one payment row (split/release/refund
  // all update the existing row rather than inserting a new one), and this
  // is what makes concurrent pay() calls for the same booking fail safely
  // instead of racing past the application-level "already paid" check —
  // see PaymentsService.createHeldPayment and
  // migrations/20260922_payments_booking_id_unique.sql.
  @Index({ unique: true })
  @Column('uuid')
  booking_id: string;

  @Column('int')
  amount: number;

  @Column()
  cashfree_order_id: string;

  @Column({ type: 'text', nullable: true })
  cashfree_payout_id: string | null;

  @Column()
  status: string; // held | refunded | released_to_host | split

  /** Only set when `status` is `split` — a dispute resolved for some
   *  amount to each party rather than all-or-nothing. The host's share is
   *  always `amount - split_amount_to_guest`, never stored separately. */
  @Column('int', { nullable: true })
  split_amount_to_guest: number | null;

  /** Mocked Cashfree Easy Split vendor-split payload, generated at
   *  createHeldPayment time — see PaymentsService.buildMockedSplitPayload.
   *  No real Cashfree call is made; this only records the shape a real
   *  Easy Split order-create call would eventually send, keyed the same
   *  way cashfree_order_id/cashfree_payout_id already are (SIMULATED-
   *  prefixed ids). */
  @Column({ type: 'jsonb', nullable: true })
  cashfree_split_payload: {
    cashfree_split_order_id: string;
    splits: { vendor_id: string; amount: number }[];
    platform_amount: number;
  } | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;
}
