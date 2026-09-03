import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('reviews')
export class ReviewEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  booking_id: string;

  @Column('uuid')
  author_id: string;

  @Column('uuid')
  target_user_id: string;

  @Column('uuid', { nullable: true })
  listing_id: string | null;

  @Column()
  role: string; // 'guest' (reviewing host/listing) | 'host' (reviewing guest)

  @Column('int')
  rating: number; // 1-5

  @Column('text')
  content: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
