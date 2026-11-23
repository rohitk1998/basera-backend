import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('listings')
export class ListingEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * NULL in the DB only for discovered (unclaimed) rows (CHECK enforces it). Typed `string`
   * deliberately so the many non-public readers keep compiling; every path that can see a
   * discovered row must test `is_discovered` / `host_id` first.
   */
  @Column('uuid', { nullable: true })
  host_id: string;

  @Index()
  @Column()
  status: string;

  @Column('jsonb', { nullable: true })
  draft_data: unknown;

  @Column({ type: 'text', nullable: true })
  review_notes: string | null;

  @Column({ type: 'text', nullable: true, default: 'not_started' })
  visit_status: string | null;

  @Column({ type: 'text', nullable: true })
  review_reason_category: string | null;

  @Column('uuid', { nullable: true })
  reviewed_by: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewed_at: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  updated_at: Date | null;

  @Column({ type: 'text', nullable: true })
  source_locale: string | null;

  /** True while the row is an unclaimed candidate; never public, bookable, chat-able or phone-revealable. */
  @Index()
  @Column({ type: 'boolean', default: false })
  is_discovered: boolean;

  @Column({ type: 'text', nullable: true })
  discovery_source: string | null;

  @Column({ type: 'text', nullable: true })
  external_place_id: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  discovered_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  claimed_at: Date | null;

  @Column('uuid', { nullable: true })
  claimed_by: string | null;

  /** Discovery pipeline state; only meaningful while is_discovered. CRM/claim code updates it. */
  @Column({ type: 'text', default: 'DISCOVERED' })
  discovery_state: string;

  @Column('uuid', { nullable: true })
  discovery_assigned_to: string | null;

  @Column({ type: 'text', nullable: true })
  discovery_destination: string | null;

  @Column({ type: 'text', nullable: true })
  discovery_category: string | null;

  @Column('uuid', { nullable: true })
  discovery_duplicate_of: string | null;

  /** Our own derived location for discovered rows (canonical HP_LOCATIONS spelling). Never Google text. */
  @Column({ type: 'text', nullable: true })
  disc_district: string | null;

  @Column({ type: 'text', nullable: true })
  disc_tehsil: string | null;

  @Column({ type: 'double precision', nullable: true })
  disc_lat: number | null;

  @Column({ type: 'double precision', nullable: true })
  disc_lng: number | null;

  /** Booking is gated separately from publication; only an admin can enable it. */
  @Column({ type: 'boolean', default: false })
  booking_eligible: boolean;
}
