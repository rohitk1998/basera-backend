import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { FinanceAuditService } from './finance-audit.service';
import { LedgerService } from './ledger.service';
import { PayoutService } from './payout.service';
import { RefundService, RefundablePayment } from './refund.service';

export type FlowPayment = RefundablePayment;

interface BookingMoney {
  host_id: string;
  commission_rate_bps: number | null;
  platform_commission: number;
  gross_booking_amount: number;
}

/** Commission on `base` rupees using the rate snapshotted on the booking (legacy rows: the stored ratio). */
export function commissionOn(base: number, b: Pick<BookingMoney, 'commission_rate_bps' | 'platform_commission' | 'gross_booking_amount'>): number {
  if (b.commission_rate_bps != null) return Math.round((base * b.commission_rate_bps) / 10_000);
  if (b.gross_booking_amount > 0) return Math.round((base * b.platform_commission) / b.gross_booking_amount);
  return 0;
}

/**
 * The one place PaymentsService calls into for money-state side effects, so ledger / refund /
 * payout posting stays out of the payment status machine. Every method is idempotent.
 */
@Injectable()
export class FinanceFlowService {
  private readonly logger = new Logger(FinanceFlowService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly refunds: RefundService,
    private readonly payouts: PayoutService,
    private readonly audit: FinanceAuditService,
  ) {}

  private async money(bookingId: string, manager?: EntityManager): Promise<BookingMoney> {
    const rows = await (manager ?? this.dataSource).query(
      'select host_id, commission_rate_bps, platform_commission, gross_booking_amount from bookings where id = $1',
      [bookingId],
    );
    return rows[0] ?? { host_id: '', commission_rate_bps: 0, platform_commission: 0, gross_booking_amount: 0 };
  }

  onHeld(p: FlowPayment, manager?: EntityManager) {
    return this.ledger.paymentHeld({ paymentId: p.id, bookingId: p.booking_id, amount: p.amount }, manager);
  }

  private async hostShare(p: FlowPayment, base: number, kind: string, manager?: EntityManager) {
    if (base <= 0) return;
    const b = await this.money(p.booking_id, manager);
    const commission = commissionOn(base, b);
    await this.ledger.hostShare({ kind, paymentId: p.id, bookingId: p.booking_id, hostId: b.host_id, base, commission }, manager);
    await this.payouts.createForPayment({ bookingId: p.booking_id, paymentId: p.id, hostId: b.host_id, amount: base - commission }, manager);
  }

  /** Held funds released to the host (full amount). */
  onRelease(p: FlowPayment, manager?: EntityManager) {
    return this.hostShare(p, p.amount, 'release', manager);
  }

  /** Cancellation: `amount` back to the guest via Cashfree, the remainder (policy-retained) goes to the host. */
  async onRefund(p: FlowPayment, amount: number, opts: { reason?: string; actor?: string | null; manager?: EntityManager }) {
    await this.refunds.request(p, amount, opts);
    await this.hostShare(p, p.amount - amount, 'retained', opts.manager);
  }

  /** Dispute resolution. prevToGuest != null means an appeal re-deciding an earlier split. */
  async onSplit(p: FlowPayment, toGuest: number, manager?: EntityManager, prevToGuest: number | null = null) {
    if (prevToGuest == null) {
      if (toGuest > 0) await this.refunds.request(p, toGuest, { reason: 'Dispute resolution', manager });
      await this.hostShare(p, p.amount - toGuest, 'split_host', manager);
      return;
    }
    const b = await this.money(p.booking_id, manager);
    const oldBase = p.amount - prevToGuest;
    const newBase = p.amount - toGuest;
    const oldC = commissionOn(oldBase, b);
    const newC = commissionOn(newBase, b);
    const delta = toGuest - prevToGuest;
    if (delta === 0) return;
    const change = (account: 'host_payable' | 'platform_commission' | 'refunds', creditDelta: number) =>
      creditDelta >= 0 ? { account, credit: creditDelta } : { account, debit: -creditDelta };
    await this.ledger.record(
      {
        idemKey: `split_redecision:${p.id}:${prevToGuest}:${toGuest}`,
        kind: 'split_redecision',
        bookingId: p.booking_id,
        paymentId: p.id,
        hostId: b.host_id,
        meta: { prevToGuest, toGuest },
        lines: [change('host_payable', newBase - newC - (oldBase - oldC)), change('platform_commission', newC - oldC), change('refunds', delta)],
      },
      manager,
    );
    if (delta > 0) {
      await this.refunds.request(p, delta, { reason: 'Dispute appeal decision', manager, postLedger: false });
    } else {
      await this.audit.log(null, 'split.redecision.manual_reconciliation', 'payment', p.id, { prevToGuest, toGuest, note: 'Guest award reduced after a refund may already have been paid.' }, manager);
      this.logger.warn(`Appeal reduced guest award on payment ${p.id}; manual reconciliation required`);
    }
    const net = newBase - newC;
    await (manager ?? this.dataSource).query(
      `update payouts set amount = $2, updated_at = now() where payment_id = $1 and state in ('pending','approved')`,
      [p.id, net],
    );
  }
}
