import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['listing_id', 'status', 'move_in', 'move_out'])
@Entity('bookings')
export class BookingEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  listing_id: string;

  @Index()
  @Column('uuid')
  guest_id: string;

  @Index()
  @Column('uuid')
  host_id: string;

  @Column()
  status: string; // requested | confirmed | checked_in | disputed | completed | declined | cancelled | expired

  @Column('date')
  move_in: string;

  @Column('date')
  move_out: string;

  @Column({ type: 'date', nullable: true })
  actual_move_out: string | null;

  @Column('int')
  months: number;

  @Column('int', { default: 1 })
  adults: number;

  @Column('int', { default: 0 })
  children: number;

  @Column('int', { default: 0 })
  infants: number;

  @Column('int', { default: 0 })
  pets: number;

  @Column('int')
  monthly_rent: number;

  @Column('int')
  deposit: number;

  @Column()
  payment_method: string; // upi | cash

  @Column('int')
  due_at_move_in: number;

  @Column('int')
  gross_booking_amount: number;

  @Column('int')
  platform_commission: number;

  @Column('int')
  host_payout_amount: number;

  // Snapshot of the commission rate/agreement in force when the booking was created.
  @Column({ type: 'int', nullable: true })
  commission_rate_bps: number | null;

  @Column({ type: 'uuid', nullable: true })
  commission_agreement_id: string | null;

  @Column({ type: 'text', nullable: true })
  rejection_reason: string | null;

  @Column({ type: 'varchar', length: 6, nullable: true })
  checkin_code: string | null; // 4-digit numeric OTP, generated for the host at approve()

  @Column({ type: 'timestamptz', nullable: true })
  checkin_time: Date | null;

  // Host attestation that they checked the guest's ID in person. Type only, never a number.
  @Column({ type: 'timestamptz', nullable: true })
  host_id_checked_at: Date | null;

  @Column({ type: 'varchar', nullable: true })
  host_id_checked_doc_type: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  escrow_release_time: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  checkout_time: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  id_disclaimer_accepted_at: Date | null;

  @Column({ type: 'text', nullable: true })
  id_disclaimer_version: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  hold_expires_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  guest_confirmed_stay_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  host_confirmed_stay_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  stay_confirmed_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  stay_prompt_sent_at: Date | null;

  // Short human-readable id, e.g. RB-7K3M2Q. Unique (bookings_reference_key).
  @Column({ type: 'varchar', length: 16, nullable: true })
  reference: string | null;

  // Client-supplied Idempotency-Key; unique per guest (bookings_guest_idempotency_key_uq).
  @Column({ type: 'varchar', length: 128, nullable: true })
  idempotency_key: string | null;

  // Set at approve(): an unpaid confirmed booking is expired after this.
  @Column({ type: 'timestamptz', nullable: true })
  pay_by_at: Date | null;
}
