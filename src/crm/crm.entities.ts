import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { ContactState, LeadSource } from './crm.types';

@Entity('host_leads')
export class HostLeadEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  /** The discovery candidate (listings.id). Null only for self-registered hosts with no candidate yet. */
  @Index({ unique: true }) @Column('uuid', { nullable: true }) listing_id: string | null;
  @Column({ type: 'text', default: 'NOT_CONTACTED' }) contact_state: ContactState;
  @Column('uuid', { nullable: true }) owner_staff_id: string | null;
  @Column({ type: 'text', nullable: true }) phone: string | null;
  @Column({ type: 'text', nullable: true }) email: string | null;
  @Column({ type: 'text', nullable: true }) contact_name: string | null;
  @Column({ type: 'text', nullable: true }) property_hint: string | null;
  @Column({ type: 'text' }) source: LeadSource;
  @Column({ type: 'timestamptz', nullable: true }) next_action_at: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) last_contacted_at: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) first_contacted_at: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) interested_at: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) invited_at: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) onboarding_at: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) converted_at: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) declined_at: Date | null;
  @Column({ type: 'text', nullable: true }) notes: string | null;
  @Column('uuid', { nullable: true }) created_by: string | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) created_at: Date;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updated_at: Date;
}

@Entity('outreach_attempts')
export class OutreachAttemptEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid') lead_id: string;
  @Column({ type: 'text' }) channel: string;
  @Column({ type: 'text', default: 'outbound' }) direction: 'outbound' | 'inbound';
  @Column({ type: 'text', nullable: true }) template: string | null;
  @Column({ type: 'text', nullable: true }) provider_message_id: string | null;
  @Column({ type: 'text', default: 'logged' }) status: string;
  @Column({ type: 'text', nullable: true }) outcome: string | null;
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` }) payload: Record<string, unknown>;
  @Column('uuid', { nullable: true }) created_by: string | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) at: Date;
}

@Entity('host_invitations')
export class HostInvitationEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid') lead_id: string;
  /** SHA-256 hex of the token. The raw token is never stored. */
  @Index({ unique: true }) @Column({ type: 'text' }) token_hash: string;
  @Column({ type: 'timestamptz' }) expires_at: Date;
  @Column({ type: 'timestamptz', nullable: true }) used_at: Date | null;
  @Column('uuid', { nullable: true }) used_by_user_id: string | null;
  @Column({ type: 'timestamptz', nullable: true }) revoked_at: Date | null;
  @Column('uuid', { nullable: true }) created_by: string | null;
  @Column({ type: 'text', default: 'manual' }) channel: string;
  @Column({ type: 'int', default: 0 }) resend_count: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) created_at: Date;
}

@Entity('follow_up_tasks')
export class FollowUpTaskEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid') lead_id: string;
  @Column({ type: 'timestamptz' }) due_at: Date;
  @Column('uuid', { nullable: true }) assignee_id: string | null;
  @Column({ type: 'text', default: 'call' }) kind: string;
  @Column({ type: 'timestamptz', nullable: true }) done_at: Date | null;
  @Column('uuid', { nullable: true }) done_by: string | null;
  @Column({ type: 'text', nullable: true }) note: string | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) created_at: Date;
}
