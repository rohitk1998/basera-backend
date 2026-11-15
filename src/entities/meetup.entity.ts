import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type MeetupStatus = 'open' | 'cancelled';

@Entity('meetups')
export class MeetupEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  host_user_id: string;

  @Column('uuid', { nullable: true })
  listing_id: string | null;

  @Column('uuid', { nullable: true })
  event_id: string | null;

  @Column({ type: 'text' })
  town: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ type: 'timestamptz' })
  starts_at: Date;

  @Column({ type: 'text' })
  place_text: string;

  @Column({ type: 'int', nullable: true })
  capacity: number | null;

  @Column({ type: 'text', default: 'open' })
  status: MeetupStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
