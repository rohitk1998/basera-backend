import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('verification_requests')
export class VerificationRequestEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  user_id: string;

  @Column()
  verification_type: string;

  @Column({ type: 'text', nullable: true })
  document_subtype: string | null;

  @Column({ default: 'pending' })
  status: string;

  @Column({ type: 'text', nullable: true })
  document_path: string | null;

  @Column({ type: 'text', nullable: true })
  document_path_back: string | null;

  @Column({ type: 'jsonb', nullable: true })
  analysis_result: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  rejection_reason: string | null;

  @Column({ type: 'uuid', nullable: true })
  reviewed_by: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewed_at: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  submitted_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;
}
