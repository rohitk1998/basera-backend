import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { PriceSnapshot } from '../bookings/offer-pricing.util';

export type BookingOfferState = 'pending' | 'accepted' | 'declined' | 'expired' | 'superseded' | 'withdrawn';

@Index(['booking_id', 'version'], { unique: true })
@Entity('booking_offers')
export class BookingOfferEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  booking_id: string;

  @Column('int')
  version: number;

  @Column({ type: 'jsonb' })
  price_snapshot: PriceSnapshot;

  @Column({ type: 'text', nullable: true })
  conditions: string | null;

  @Column({ type: 'text', nullable: true })
  host_message: string | null;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ type: 'text', default: 'pending' })
  state: BookingOfferState;

  @Column({ type: 'timestamptz', nullable: true })
  accepted_at: Date | null;

  @Column({ type: 'uuid', nullable: true })
  created_by: string | null;

  /** Client Idempotency-Key for offer creation (unique per booking). */
  @Column({ type: 'varchar', length: 128, nullable: true })
  idempotency_key: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
