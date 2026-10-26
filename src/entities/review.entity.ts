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
  role: string;

  @Column('int')
  rating: number;

  @Column('text')
  content: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
