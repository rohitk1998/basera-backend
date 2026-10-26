import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('listings')
export class ListingEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
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
}
