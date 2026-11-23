import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Failed check-in-code attempts per booking, shared across API instances. */
@Entity('check_in_lockouts')
export class BookingCheckinLockoutEntity {
  @PrimaryColumn('uuid')
  booking_id: string;

  @Column('int', { default: 0 })
  failed_count: number;

  @Column({ type: 'timestamptz', nullable: true })
  locked_until: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;
}
