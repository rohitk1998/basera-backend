import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BookingsService } from '../bookings/bookings.service';
import { FinanceFlowService } from '../finance/finance-flow.service';
import { RefundService } from '../finance/refund.service';
import { CashfreeService } from './cashfree.service';
import { PaymentsService } from './payments.service';

export const STALE_PENDING_MS = 15 * 60 * 1000;

export interface ReconcileSummary {
  stalePending: number;
  synced: number;
  closed: number;
  refundedLate: number;
  refundsDispatched: number;
  refundsPolled: number;
  ledgerBackfilled: number;
  errors: number;
}

/** Idempotent catch-up for everything a missed webhook or a crash can leave behind. */
@Injectable()
export class PaymentsReconciler {
  private readonly logger = new Logger(PaymentsReconciler.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly cashfree: CashfreeService,
    private readonly bookings: BookingsService,
    private readonly refunds: RefundService,
    private readonly flow: FinanceFlowService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async run(): Promise<ReconcileSummary> {
    const s: ReconcileSummary = { stalePending: 0, synced: 0, closed: 0, refundedLate: 0, refundsDispatched: 0, refundsPolled: 0, ledgerBackfilled: 0, errors: 0 };
    const guard = async (fn: () => Promise<void>, what: string) => {
      try {
        await fn();
      } catch (e) {
        s.errors += 1;
        this.logger.warn(`[reconcile] ${what}: ${(e as Error).message}`);
      }
    };

    const stale = await this.payments.listStalePending(STALE_PENDING_MS);
    s.stalePending = stale.length;
    for (const p of stale) {
      await guard(async () => {
        const [b] = await this.dataSource.query('select status from bookings where id = $1', [p.booking_id]);
        const live = b && ['confirmed', 'awaiting_payment'].includes(b.status);
        if (!live) {
          const order = await this.cashfree.fetchPgOrder(p.cashfree_order_id);
          if (order?.status === 'PAID') {
            // Paid on a cancelled/expired booking: syncPayment holds it, onPaymentHeld refunds it for real.
            await this.bookings.syncPayment(p.booking_id);
            s.refundedLate += 1;
            return;
          }
          if (order?.status === 'ACTIVE') {
            await this.payments.closePendingOrder(p.booking_id);
            s.closed += 1;
            return;
          }
        }
        await this.bookings.syncPayment(p.booking_id);
        s.synced += 1;
      }, `payment ${p.id}`);
    }

    for (const r of await this.refunds.sweepable()) {
      await guard(async () => {
        if (r.state === 'requested') {
          await this.refunds.dispatch(r.id);
          s.refundsDispatched += 1;
        } else {
          await this.refunds.poll(r.id);
          s.refundsPolled += 1;
        }
      }, `refund ${r.id}`);
    }

    const missing = await this.dataSource.query(
      `select p.id, p.booking_id, p.amount, p.cashfree_order_id from payments p
        where p.status = 'held' and not exists (select 1 from ledger_entries l where l.payment_id = p.id and l.kind = 'payment_held')
        limit 100`,
    );
    for (const p of missing) {
      await guard(async () => {
        await this.flow.onHeld(p);
        s.ledgerBackfilled += 1;
      }, `ledger backfill ${p.id}`);
    }
    return s;
  }
}
