import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// listing_id + status + the date range together back the listings-search
// overlap check (NOT EXISTS ... WHERE listing_id = ... AND status = ANY(...)
// AND move_in < ... AND move_out > ...) — see
// migrations/20260921_perf_indexes.sql.
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

  @Column({ type: 'text', nullable: true })
  rejection_reason: string | null;

  @Column({ type: 'varchar', length: 6, nullable: true })
  checkin_code: string | null; // 4-digit numeric OTP, generated for the host at approve()

  @Column({ type: 'timestamptz', nullable: true })
  checkin_time: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  escrow_release_time: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  checkout_time: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;
}
