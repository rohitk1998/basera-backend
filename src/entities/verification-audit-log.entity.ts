import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('verification_audit_log')
export class VerificationAuditLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  verification_request_id: string | null;

  @Column('uuid')
  user_id: string;

  @Column({ type: 'uuid', nullable: true })
  admin_id: string | null;

  @Column()
  action: string;

  @Column({ type: 'text', nullable: true })
  previous_status: string | null;

  @Column({ type: 'text', nullable: true })
  new_status: string | null;

  @Column({ type: 'text', nullable: true })
  rejection_reason: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
