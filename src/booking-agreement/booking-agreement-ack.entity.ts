import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Unique(['booking_id', 'user_id'])
@Index(['booking_id'])
@Entity('booking_agreement_acks')
export class BookingAgreementAckEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  booking_id: string;

  @Column('uuid')
  user_id: string;

  @Column('text')
  version: string;

  @Column('text')
  text_hash: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  acknowledged_at: Date;

  @Column({ type: 'text', nullable: true })
  ip: string | null;
}
