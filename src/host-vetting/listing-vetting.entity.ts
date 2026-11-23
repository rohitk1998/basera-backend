import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { RatingSource } from './host-vetting.constants';

/** One row per listing: what the admin found on an external platform. Typed in by hand, never scraped. */
@Entity('listing_vetting')
export class ListingVettingEntity {
  @PrimaryColumn('uuid')
  listing_id: string;

  // numeric comes back from pg as a string; the service converts it.
  @Column({ type: 'numeric', precision: 2, scale: 1, nullable: true })
  external_rating: string | null;

  @Column({ type: 'text', nullable: true })
  external_rating_source: RatingSource | null;

  @Column({ type: 'int', nullable: true })
  external_review_count: number | null;

  @Column({ type: 'text', nullable: true })
  external_url: string | null;

  @Column({ type: 'uuid', nullable: true })
  checked_by: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  checked_at: Date | null;
}
