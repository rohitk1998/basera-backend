import { commissionOn, FinanceFlowService } from './finance-flow.service';
import { LedgerService } from './ledger.service';
import { fakeLedgerDb } from './finance.test-utils';

const P = { id: 'p1', booking_id: 'b1', amount: 1000, cashfree_order_id: 'bk_1' };

function setup(booking: any) {
  const db = fakeLedgerDb();
  const ledger = new LedgerService(db.ds);
  const baseQuery = db.query;
  const query = jest.fn(async (sql: string, p: any[]) => {
    if (sql.includes('from bookings where id')) return [booking];
    if (sql.startsWith('update payouts')) return [];
    return baseQuery(sql, p);
  });
  const ds: any = { query, transaction: async (cb: any) => cb({ query }) };
  const refunds: any = { request: jest.fn() };
  const payouts: any = { createForPayment: jest.fn() };
  const audit: any = { log: jest.fn() };
  const flow = new FinanceFlowService(ds, ledger, refunds, payouts, audit);
  return { flow, db, refunds, payouts, audit };
}
const booking = (bps: number | null) => ({ host_id: 'h1', commission_rate_bps: bps, platform_commission: 0, gross_booking_amount: 1000 });

describe('commissionOn', () => {
  it('uses the snapshotted bps; 0 in the free period; legacy rows fall back to the stored ratio', () => {
    expect(commissionOn(1000, { commission_rate_bps: 600, platform_commission: 0, gross_booking_amount: 1000 })).toBe(60);
    expect(commissionOn(1000, { commission_rate_bps: 0, platform_commission: 60, gross_booking_amount: 1000 })).toBe(0);
    expect(commissionOn(500, { commission_rate_bps: null, platform_commission: 60, gross_booking_amount: 1000 })).toBe(30);
    expect(commissionOn(500, { commission_rate_bps: null, platform_commission: 0, gross_booking_amount: 0 })).toBe(0);
  });
});

describe('FinanceFlowService', () => {
  it('release in the free period: host gets everything, no commission, one payout', async () => {
    const t = setup(booking(0));
    await t.flow.onHeld(P);
    await t.flow.onRelease(P);
    expect(t.db.balance('host_payable')).toBe(1000);
    expect(t.db.balance('platform_commission')).toBe(0);
    expect(t.payouts.createForPayment).toHaveBeenCalledWith({ bookingId: 'b1', paymentId: 'p1', hostId: 'h1', amount: 1000 }, undefined);
  });

  it('release with a 6% snapshot, replayed: commission posted once', async () => {
    const t = setup(booking(600));
    await t.flow.onRelease(P);
    await t.flow.onRelease(P);
    expect(t.db.balance('platform_commission')).toBe(60);
    expect(t.db.balance('host_payable')).toBe(940);
  });

  it('partial cancellation refund: refund request + retained share to the host', async () => {
    const t = setup(booking(0));
    await t.flow.onRefund(P, 400, { reason: 'cancel' });
    expect(t.refunds.request).toHaveBeenCalledWith(P, 400, { reason: 'cancel' });
    expect(t.db.balance('host_payable')).toBe(600);
  });

  it('full refund retains nothing for the host', async () => {
    const t = setup(booking(600));
    await t.flow.onRefund(P, 1000, {});
    expect(t.db.rows).toHaveLength(0);
    expect(t.payouts.createForPayment).not.toHaveBeenCalled();
  });

  it('split: refunds the guest share and posts the host share', async () => {
    const t = setup(booking(600));
    await t.flow.onSplit(P, 250);
    expect(t.refunds.request).toHaveBeenCalledWith(P, 250, { reason: 'Dispute resolution', manager: undefined });
    expect(t.db.balance('platform_commission')).toBe(45);
    expect(t.db.balance('host_payable')).toBe(705);
  });

  it('appeal re-decision posts a balanced delta and requests only the extra refund', async () => {
    const t = setup(booking(600));
    await t.flow.onSplit(P, 250);
    await t.flow.onSplit(P, 500, undefined, 250);
    expect(t.refunds.request).toHaveBeenLastCalledWith(P, 250, expect.objectContaining({ postLedger: false }));
    expect(t.db.balance('host_payable')).toBe(470);
    expect(t.db.balance('platform_commission')).toBe(30);
    expect(t.db.groupsBalanced()).toBe(true);
  });

  it('appeal that lowers the guest award flags manual reconciliation instead of refunding', async () => {
    const t = setup(booking(0));
    await t.flow.onSplit(P, 500);
    t.refunds.request.mockClear();
    await t.flow.onSplit(P, 200, undefined, 500);
    expect(t.refunds.request).not.toHaveBeenCalled();
    expect(t.audit.log).toHaveBeenCalledWith(null, 'split.redecision.manual_reconciliation', 'payment', 'p1', expect.anything(), undefined);
    expect(t.db.groupsBalanced()).toBe(true);
  });
});
