import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { CashfreeService } from '../payments/cashfree.service';
import { FinanceAuditService } from './finance-audit.service';
import { LedgerService } from './ledger.service';
import type { RefundEntity, RefundState } from './entities';

export interface RefundablePayment {
  id: string;
  booking_id: string;
  amount: number;
  cashfree_order_id: string;
}

const DISPATCH_DELAY_MS = 1_500;

/** Map a Cashfree refund_status to our state. PENDING/ONHOLD stay pending. */
export function mapRefundStatus(cf: string | undefined): RefundState {
  switch ((cf ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'success';
    case 'CANCELLED':
    case 'FAILED':
      return 'failed';
    default:
      return 'pending';
  }
}

/** Cashfree refund_id: alphanumeric/underscore, <= 55 chars. Retries add a generation suffix. */
export function cashfreeRefundId(id: string, generation: number): string {
  return `rf_${id.replace(/-/g, '')}${generation > 0 ? `_${generation}` : ''}`;
}

export function parseCashfreeRefundId(refundId: string): { id: string; generation: number } | null {
  const m = /^rf_([0-9a-f]{32})(?:_(\d+))?$/.exec(refundId);
  if (!m) return null;
  const h = m[1];
  return { id: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`, generation: m[2] ? Number(m[2]) : 0 };
}

@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cashfree: CashfreeService,
    private readonly ledger: LedgerService,
    private readonly audit: FinanceAuditService,
  ) {}

  /**
   * Record a refund request (row + ledger) and dispatch it to Cashfree. Legacy/simulated payments
   * (cashfree_order_id SIMULATED-*) are settled immediately with provider 'legacy'. When called with a
   * transaction manager, the Cashfree call is deferred until after commit (short timer) and is also
   * picked up by the reconcile sweep, so a rolled-back transaction never produces a gateway refund
   * (the timer re-reads the row; a rolled-back row simply is not found).
   */
  async request(
    payment: RefundablePayment,
    amount: number,
    opts: { reason?: string; actor?: string | null; manager?: EntityManager; postLedger?: boolean } = {},
  ): Promise<RefundEntity> {
    if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException('Refund amount must be a positive whole number of rupees.');
    const db = opts.manager ?? this.dataSource;
    const [{ requested }] = await db.query(
      `select coalesce(sum(amount) filter (where state <> 'failed'), 0)::int as requested from refunds where payment_id = $1`,
      [payment.id],
    );
    if (Number(requested) + amount > payment.amount) {
      throw new ConflictException('Refund would exceed the amount paid.');
    }
    const legacy = payment.cashfree_order_id.startsWith('SIMULATED-');
    const rows = await db.query(
      `insert into refunds (booking_id, payment_id, amount, state, provider, reason, requested_by, processed_at)
       values ($1,$2,$3,$4,$5,$6,$7, $8) returning *`,
      [payment.booking_id, payment.id, amount, legacy ? 'success' : 'requested', legacy ? 'legacy' : 'cashfree', opts.reason ?? null, opts.actor ?? null, legacy ? new Date() : null],
    );
    const refund = rows[0] as RefundEntity;
    if (opts.postLedger !== false) {
      await this.ledger.refundRequested({ refundId: refund.id, generation: 0, paymentId: payment.id, bookingId: payment.booking_id, amount }, opts.manager);
    }
    if (legacy) {
      await this.ledger.refundSettled({ refundId: refund.id, paymentId: payment.id, bookingId: payment.booking_id, amount }, opts.manager);
      return refund;
    }
    if (opts.manager) {
      const t = setTimeout(() => void this.dispatch(refund.id).catch((e) => this.logger.warn(`deferred refund dispatch ${refund.id}: ${e.message}`)), DISPATCH_DELAY_MS);
      t.unref?.();
    } else {
      await this.dispatch(refund.id).catch((e) => this.logger.warn(`refund dispatch ${refund.id}: ${e.message}`));
    }
    return refund;
  }

  private async load(id: string): Promise<(RefundEntity & { cashfree_order_id: string }) | null> {
    const rows = await this.dataSource.query(
      `select r.*, p.cashfree_order_id from refunds r join payments p on p.id = r.payment_id where r.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Send a 'requested' refund to Cashfree (idempotent by refund_id). Leaves it 'requested' on a transport error. */
  async dispatch(id: string): Promise<RefundEntity | null> {
    const r = await this.load(id);
    if (!r || r.state !== 'requested') return r;
    try {
      const cf = await this.cashfree.createRefund(r.cashfree_order_id, cashfreeRefundId(r.id, r.attempts), r.amount, r.reason ?? 'Booking refund');
      await this.dataSource.query(
        `update refunds set cf_refund_id = $2, cf_refund_status = $3, updated_at = now() where id = $1`,
        [id, cf.cfRefundId, cf.status],
      );
      return await this.applyStatus(id, cf.status);
    } catch (e: any) {
      const permanent = e?.cashfreeStatus && e.cashfreeStatus >= 400 && e.cashfreeStatus < 500;
      await this.dataSource.query(`update refunds set failure_reason = $2, updated_at = now() where id = $1`, [id, String(e?.message ?? e).slice(0, 500)]);
      if (permanent) return this.applyStatus(id, 'FAILED', String(e?.message ?? 'rejected by gateway'));
      throw e;
    }
  }

  /** Guarded transition + ledger; safe to call repeatedly (webhook replays, reconcile polls). */
  async applyStatus(id: string, cfStatus: string, failureReason?: string): Promise<RefundEntity | null> {
    const next = mapRefundStatus(cfStatus);
    return this.dataSource.transaction(async (m) => {
      const rows = await m.query(
        `update refunds set state = $2, cf_refund_status = $3, failure_reason = coalesce($4, failure_reason),
                processed_at = case when $2 in ('success','failed') then now() else processed_at end, updated_at = now()
          where id = $1 and state in ('requested','pending') and state <> $2
        returning *`,
        [id, next, cfStatus, failureReason ?? null],
      );
      const r = rows[0] as RefundEntity | undefined;
      if (!r) {
        const cur = await m.query('select * from refunds where id = $1', [id]);
        return (cur[0] as RefundEntity) ?? null;
      }
      if (next === 'success') {
        await this.ledger.refundSettled({ refundId: r.id, paymentId: r.payment_id, bookingId: r.booking_id, amount: r.amount }, m);
      } else if (next === 'failed') {
        await this.ledger.refundFailed({ refundId: r.id, generation: r.attempts, paymentId: r.payment_id, bookingId: r.booking_id, amount: r.amount }, m);
        await this.audit.log(null, 'refund.failed', 'refund', r.id, { cfStatus, failureReason }, m);
      }
      return r;
    });
  }

  /** REFUND_STATUS_WEBHOOK handler. Unknown refund ids are ignored (returns null). */
  async handleWebhook(refund: { refund_id?: string; refund_status?: string; status_description?: string } | undefined): Promise<RefundEntity | null> {
    const parsed = refund?.refund_id ? parseCashfreeRefundId(refund.refund_id) : null;
    if (!parsed || !refund?.refund_status) return null;
    const row = await this.load(parsed.id);
    if (!row || row.attempts !== parsed.generation) return null; // stale generation
    return this.applyStatus(parsed.id, refund.refund_status, refund.status_description);
  }

  /** Poll Cashfree for a pending refund (reconcile job). */
  async poll(id: string): Promise<RefundEntity | null> {
    const r = await this.load(id);
    if (!r || r.state !== 'pending') return r;
    const cf = await this.cashfree.getRefund(r.cashfree_order_id, cashfreeRefundId(r.id, r.attempts));
    if (!cf) return r;
    return this.applyStatus(id, cf.status);
  }

  /** Admin retry of a failed refund: new Cashfree refund_id generation, ledger re-requested. */
  async retry(id: string, actor: string): Promise<RefundEntity> {
    const rows = await this.dataSource.transaction(async (m) => {
      const updated = await m.query(
        `update refunds set state = 'requested', attempts = attempts + 1, failure_reason = null, cf_refund_status = null,
                processed_at = null, updated_at = now()
          where id = $1 and state = 'failed' and provider = 'cashfree' returning *`,
        [id],
      );
      if (!updated.length) return null;
      const r = updated[0] as RefundEntity;
      await this.ledger.refundRequested({ refundId: r.id, generation: r.attempts, paymentId: r.payment_id, bookingId: r.booking_id, amount: r.amount }, m);
      await this.audit.log(actor, 'refund.retry', 'refund', id, { generation: r.attempts }, m);
      return r;
    });
    if (!rows) {
      const exists = await this.load(id);
      if (!exists) throw new NotFoundException('Refund not found');
      throw new ConflictException('Only failed Cashfree refunds can be retried.');
    }
    await this.dispatch(id).catch((e) => this.logger.warn(`retry dispatch ${id}: ${e.message}`));
    return (await this.load(id))!;
  }

  /** Refunds the sweep must act on: unsent for > 30s, or pending for > 2 min. */
  async sweepable(limit = 50): Promise<{ id: string; state: RefundState }[]> {
    return this.dataSource.query(
      `select id, state from refunds
        where provider = 'cashfree'
          and ((state = 'requested' and updated_at < now() - interval '30 seconds')
            or (state = 'pending' and updated_at < now() - interval '2 minutes'))
        order by updated_at limit $1`,
      [limit],
    );
  }
}
