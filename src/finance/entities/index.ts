import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

export type CommissionScope = 'global' | 'host' | 'property';
export type LedgerAccount =
  | 'guest_receivable'
  | 'platform_cash'
  | 'host_payable'
  | 'platform_commission'
  | 'refunds'
  | 'adjustments';
export type RefundState = 'requested' | 'pending' | 'success' | 'failed';
export type PayoutState = 'pending' | 'approved' | 'processing' | 'paid' | 'failed';

@Entity('platform_settings')
export class PlatformSettingEntity {
  @PrimaryColumn() key: string;
  @Column('jsonb') value: unknown;
  @Column({ type: 'uuid', nullable: true }) updated_by: string | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updated_at: Date;
}

@Entity('commission_agreements')
export class CommissionAgreementEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() scope: CommissionScope;
  @Column({ type: 'uuid', nullable: true }) scope_id: string | null;
  @Column('int') rate_bps: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) effective_from: Date;
  @Column({ type: 'timestamptz', nullable: true }) effective_to: Date | null;
  @Column({ type: 'int', nullable: true }) free_period_cap: number | null;
  @Column({ type: 'text', nullable: true }) reason: string | null;
  @Column({ type: 'uuid', nullable: true }) created_by: string | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) created_at: Date;
}

@Entity('ledger_entries')
export class LedgerEntryEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid', nullable: true }) booking_id: string | null;
  @Column({ type: 'uuid', nullable: true }) payment_id: string | null;
  @Column('uuid') entry_group: string;
  @Column('int', { default: 1 }) line_no: number;
  @Column() kind: string;
  @Column() idem_key: string;
  @Column() account: LedgerAccount;
  @Column('int', { default: 0 }) debit: number;
  @Column('int', { default: 0 }) credit: number;
  @Column({ default: 'INR' }) currency: string;
  @Column({ type: 'text', nullable: true }) ref: string | null;
  @Column({ type: 'jsonb', default: () => "'{}'" }) meta: Record<string, unknown>;
  @Column({ type: 'timestamptz', default: () => 'now()' }) created_at: Date;
}

@Entity('refunds')
export class RefundEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') booking_id: string;
  @Column('uuid') payment_id: string;
  @Column('int') amount: number;
  @Column({ default: 'requested' }) state: RefundState;
  @Column({ default: 'cashfree' }) provider: 'cashfree' | 'legacy';
  @Column({ type: 'text', nullable: true }) reason: string | null;
  @Column({ type: 'text', nullable: true }) cf_refund_id: string | null;
  @Column({ type: 'text', nullable: true }) cf_refund_status: string | null;
  @Column({ type: 'text', nullable: true }) failure_reason: string | null;
  @Column('int', { default: 0 }) attempts: number;
  @Column({ type: 'uuid', nullable: true }) requested_by: string | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) created_at: Date;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updated_at: Date;
  @Column({ type: 'timestamptz', nullable: true }) processed_at: Date | null;
}

@Entity('payouts')
export class PayoutEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') booking_id: string;
  @Column('uuid') payment_id: string;
  @Column('uuid') host_id: string;
  @Column('int') amount: number;
  @Column({ default: 'pending' }) state: PayoutState;
  @Column({ default: 'manual' }) provider: string;
  @Column({ type: 'text', nullable: true }) bank_reference: string | null;
  @Column({ type: 'text', nullable: true }) failure_reason: string | null;
  @Column({ type: 'uuid', nullable: true }) approved_by: string | null;
  @Column({ type: 'timestamptz', nullable: true }) approved_at: Date | null;
  @Column({ type: 'uuid', nullable: true }) paid_by: string | null;
  @Column({ type: 'timestamptz', nullable: true }) paid_at: Date | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) created_at: Date;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updated_at: Date;
}

@Entity('finance_adjustments')
export class FinanceAdjustmentEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid', nullable: true }) booking_id: string | null;
  @Column('uuid') host_id: string;
  @Column() direction: 'host_credit' | 'host_debit';
  @Column('int') amount: number;
  @Column() reason: string;
  @Column({ default: 'pending' }) state: 'pending' | 'approved' | 'rejected';
  @Column('boolean', { default: true }) requires_second_approval: boolean;
  @Column('uuid') requested_by: string;
  @Column({ type: 'uuid', nullable: true }) approved_by: string | null;
  @Column({ type: 'text', nullable: true }) decision_note: string | null;
  @Column({ type: 'timestamptz', nullable: true }) decided_at: Date | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) created_at: Date;
}

@Entity('finance_audit_log')
export class FinanceAuditEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid', nullable: true }) actor: string | null;
  @Column() action: string;
  @Column() entity: string;
  @Column({ type: 'text', nullable: true }) entity_id: string | null;
  @Column({ type: 'jsonb', default: () => "'{}'" }) data: Record<string, unknown>;
  @Column({ type: 'timestamptz', default: () => 'now()' }) at: Date;
}
