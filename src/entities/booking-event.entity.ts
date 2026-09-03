import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('booking_events')
export class BookingEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  booking_id: string;

  @Column({ type: 'text', nullable: true })
  from_status: string | null;

  @Column()
  to_status: string;

  @Column('uuid')
  actor: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  at: Date;
}
