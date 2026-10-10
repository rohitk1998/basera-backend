import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('listings')
export class ListingEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  host_id: string;

  // Every public search/summary query starts with `WHERE status = 'live'`
  // (also the admin dashboard's per-status counts) — see
  // migrations/20260921_perf_indexes.sql.
  @Index()
  @Column()
  status: string;

  // Schema-on-read JSON blob holding property_details/telemetry/banking.
  // See lib/listing-mapper.ts (rowToListing) in the original Next.js app for the
  // exact read shape this must be ported to match.
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

  // Detected language of the host's free-text content (title/description/
  // etc.), set lazily on first translation request. See
  // ListingTranslationService.
  @Column({ type: 'text', nullable: true })
  source_locale: string | null;
}
