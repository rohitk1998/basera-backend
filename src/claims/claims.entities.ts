import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { ClaimRole, ClaimState, EvidenceKind } from './claims.constants';

@Entity('property_claims')
export class PropertyClaimEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid') listing_id: string;
  @Index() @Column('uuid') claimant_user_id: string;
  @Column('text') role: ClaimRole;
  @Column({ type: 'text', nullable: true }) business_name: string | null;
  @Column({ type: 'text', nullable: true }) contact_phone: string | null;
  @Column({ type: 'text', nullable: true }) contact_email: string | null;
  @Column({ type: 'text', nullable: true }) authority_statement: string | null;
  @Column({ type: 'text', nullable: true }) terms_version: string | null;
  @Column({ type: 'timestamptz', nullable: true }) terms_accepted_at: Date | null;
  @Column({ type: 'uuid', nullable: true }) invitation_id: string | null;
  @Column({ type: 'text', default: 'DRAFT' }) state: ClaimState;
  @Column({ type: 'uuid', nullable: true }) reviewer_id: string | null;
  @Column({ type: 'timestamptz', nullable: true }) decided_at: Date | null;
  @Column({ type: 'text', nullable: true }) decision_note: string | null;
  @Column({ type: 'text', nullable: true }) info_request_note: string | null;
  @Column({ type: 'timestamptz', nullable: true }) submitted_at: Date | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) created_at: Date;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updated_at: Date;
}

@Entity('claim_evidence')
export class ClaimEvidenceEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid') claim_id: string;
  @Column('text') kind: EvidenceKind;
  @Column('text') storage_path: string;
  @Column('text') mime: string;
  @Column('int') size: number;
  @Column('text') sha256: string;
  @Column({ type: 'timestamptz', default: () => 'now()' }) uploaded_at: Date;
  @Column({ type: 'timestamptz', default: () => "now() + interval '180 days'" }) retention_until: Date;
  @Column({ type: 'timestamptz', nullable: true }) purged_at: Date | null;
}

/** Append-only (DB trigger). The service only ever inserts. */
@Entity('claim_events')
export class ClaimEventEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid') claim_id: string;
  @Column({ type: 'uuid', nullable: true }) actor_id: string | null;
  @Column('text') actor_role: string;
  @Column('text') action: string;
  @Column({ type: 'jsonb', default: () => "'{}'" }) meta: Record<string, unknown>;
  @Column({ type: 'timestamptz', default: () => 'now()' }) at: Date;
}

@Entity('claim_disputes')
export class ClaimDisputeEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid') listing_id: string;
  @Column('uuid', { array: true }) claim_ids: string[];
  @Column({ type: 'timestamptz', default: () => 'now()' }) opened_at: Date;
  @Column({ type: 'uuid', nullable: true }) resolved_by: string | null;
  @Column({ type: 'timestamptz', nullable: true }) resolved_at: Date | null;
  @Column({ type: 'text', nullable: true }) resolution: string | null;
}

@Entity('property_members')
@Index(['listing_id', 'user_id'], { unique: true })
export class PropertyMemberEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') listing_id: string;
  @Column('uuid') user_id: string;
  @Column('text') role: ClaimRole;
  @Column({ type: 'uuid', nullable: true }) granted_by: string | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) granted_at: Date;
  @Column({ type: 'timestamptz', nullable: true }) revoked_at: Date | null;
}
