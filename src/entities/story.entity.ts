import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type StoryStatus = 'pending' | 'published' | 'rejected' | 'withdrawn';

@Entity('stories')
export class StoryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  author_id: string;

  @Column('uuid', { nullable: true })
  booking_id: string | null;

  @Column('uuid', { nullable: true })
  listing_id: string | null;

  @Column('uuid', { nullable: true })
  event_id: string | null;

  @Column({ type: 'text' })
  town: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  media_urls: string[];

  @Column({ type: 'boolean', default: false })
  marketing_consent: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  consent_at: Date | null;

  @Column({ type: 'text', default: 'pending' })
  status: StoryStatus;

  @Column({ type: 'timestamptz', nullable: true })
  published_at: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
