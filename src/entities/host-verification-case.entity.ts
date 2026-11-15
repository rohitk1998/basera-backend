import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type HostVerificationStatus = 'consented' | 'submitted' | 'approved' | 'rejected' | 'expired';
export type HostIdDocType = 'driving_license' | 'voter_id' | 'passport' | 'aadhaar_masked';

@Index(['user_id', 'created_at'])
@Entity('host_verification_cases')
export class HostVerificationCaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  user_id: string;

  @Column({ type: 'text', default: 'consented' })
  status: HostVerificationStatus;

  @Column('text')
  consent_version: string;

  @Column({ type: 'timestamptz' })
  consent_at: Date;

  @Column({ type: 'text', nullable: true })
  doc_type: HostIdDocType | null;

  @Column({ type: 'text', nullable: true })
  id_number_hash: string | null;

  @Column({ type: 'text', nullable: true })
  doc_path: string | null;

  @Column('text', { array: true, nullable: true })
  liveness_paths: string[] | null;

  @Column('text', { array: true, nullable: true })
  challenges: string[] | null;

  @Column({ type: 'real', nullable: true })
  face_score: number | null;

  @Column({ type: 'text', default: 'pending' })
  face_status: 'pending' | 'scored' | 'unavailable';

  @Column({ type: 'text', nullable: true })
  rejection_reason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  submitted_at: Date | null;

  @Column({ type: 'uuid', nullable: true })
  reviewed_by: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewed_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  purged_at: Date | null;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
