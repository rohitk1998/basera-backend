import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('dispute_events')
export class DisputeEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  dispute_case_id: string;

  @Column('uuid')
  actor_id: string;

  @Column()
  actor_role: string;

  @Column()
  event_type: string;

  @Column('int', { nullable: true })
  offer_amount: number | null;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
