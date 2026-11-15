import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['case_id', 'at'])
@Entity('verification_audits')
export class VerificationAuditEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  case_id: string | null;

  @Column('uuid')
  user_id: string;

  @Column({ type: 'uuid', nullable: true })
  actor_id: string | null;

  @Column('text')
  action: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  meta: Record<string, unknown>;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  at: Date;
}
