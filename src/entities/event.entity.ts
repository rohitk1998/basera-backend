import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type EventStatus = 'draft' | 'published';

@Entity('events')
export class EventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', unique: true })
  slug: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ type: 'text' })
  town: string;

  @Column({ type: 'text' })
  district: string;

  // date columns come back from pg as 'YYYY-MM-DD' strings
  @Column({ type: 'date' })
  starts_on: string;

  @Column({ type: 'date' })
  ends_on: string;

  @Column({ type: 'double precision', nullable: true })
  lat: number | null;

  @Column({ type: 'double precision', nullable: true })
  lng: number | null;

  @Column({ type: 'text', nullable: true })
  image_url: string | null;

  @Column({ type: 'text', default: 'draft' })
  status: EventStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
