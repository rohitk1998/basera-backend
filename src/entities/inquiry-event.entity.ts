import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Append-only (DB trigger rejects UPDATE/DELETE). */
@Entity('inquiry_events')
export class InquiryEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  inquiry_id: string;

  @Column({ type: 'text' })
  type: string;

  @Column({ type: 'text', nullable: true })
  from_state: string | null;

  @Column({ type: 'text', nullable: true })
  to_state: string | null;

  @Column('uuid', { nullable: true })
  actor_id: string | null;

  @Column('jsonb', { default: () => "'{}'" })
  meta: Record<string, unknown>;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  at: Date;
}
