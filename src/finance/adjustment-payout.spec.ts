import { ConflictException, ForbiddenException } from '@nestjs/common';
import { AdjustmentService } from './adjustment.service';
import { CashfreePayoutProvider, ManualPayoutProvider, PayoutService } from './payout.service';

function adjSetup(threshold = 0, stored?: any) {
  const row = stored ?? { id: 'a1', host_id: 'h', direction: 'host_credit', amount: 500, state: 'pending', requires_second_approval: true, requested_by: 'adminA', booking_id: null };
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    if (sql.startsWith('insert into finance_adjustments')) return [{ ...row, amount: p[3], requires_second_approval: p[5], requested_by: p[6] }];
    if (sql.startsWith('select * from finance_adjustments where id')) return [row];
    if (sql.includes("set state = 'approved'")) return row.state === 'pending' ? [{ ...row, state: 'approved', approved_by: p[1] }] : [];
    if (sql.includes("set state = 'rejected'")) return row.state === 'pending' ? [{ ...row, state: 'rejected' }] : [];
    throw new Error(sql);
  });
  const ds: any = { query, transaction: async (cb: any) => cb({ query }) };
  const ledger: any = { adjustment: jest.fn() };
  const settings: any = { get: jest.fn(async () => threshold) };
  const audit: any = { log: jest.fn() };
  return { svc: new AdjustmentService(ds, ledger, settings, audit), ledger, audit };
}

describe('AdjustmentService two-person rule', () => {
  it('the requester cannot approve their own adjustment', async () => {
    const { svc, ledger } = adjSetup();
    await expect(svc.approve('a1', 'adminA')).rejects.toBeInstanceOf(ForbiddenException);
    expect(ledger.adjustment).not.toHaveBeenCalled();
  });

  it('a different admin approves: ledger is posted and the action audit logged', async () => {
    const { svc, ledger, audit } = adjSetup();
    await svc.approve('a1', 'adminB', 'ok');
    expect(ledger.adjustment).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', amount: 500, direction: 'host_credit' }), expect.anything());
    expect(audit.log).toHaveBeenCalledWith('adminB', 'adjustment.approve', 'adjustment', 'a1', expect.anything(), expect.anything());
  });

  it('an already decided adjustment cannot be approved again', async () => {
    const { svc } = adjSetup(0, { id: 'a1', state: 'approved', requested_by: 'x', requires_second_approval: true });
    await expect(svc.approve('a1', 'adminB')).rejects.toBeInstanceOf(ConflictException);
  });

  it('threshold: amounts below it do not require a second admin, amounts at/above do', async () => {
    const small = adjSetup(1000);
    expect((await small.svc.request('adminA', { hostId: 'h', direction: 'host_credit', amount: 500, reason: 'goodwill' })).requires_second_approval).toBe(false);
    const big = adjSetup(1000);
    expect((await big.svc.request('adminA', { hostId: 'h', direction: 'host_credit', amount: 1000, reason: 'goodwill' })).requires_second_approval).toBe(true);
  });

  it('default threshold 0: every adjustment needs a second admin; request is audit logged; bad amounts rejected', async () => {
    const { svc, audit } = adjSetup(0);
    expect((await svc.request('adminA', { hostId: 'h', direction: 'host_debit', amount: 1, reason: 'fix' })).requires_second_approval).toBe(true);
    expect(audit.log).toHaveBeenCalledWith('adminA', 'adjustment.request', 'adjustment', expect.any(String), expect.anything());
    await expect(svc.request('adminA', { hostId: 'h', direction: 'host_debit', amount: 0, reason: 'x' })).rejects.toThrow();
  });
});

function payoutSetup(state = 'pending') {
  let row: any = { id: 'po1', booking_id: 'b', payment_id: 'p', host_id: 'h', amount: 940, state, provider: 'manual' };
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    if (sql.startsWith('select * from payouts')) return [row];
    if (sql.includes("set state = 'approved'")) {
      if (row.state !== 'pending') return [];
      row = { ...row, state: 'approved', provider: p[2] };
      return [row];
    }
    if (sql.includes('set failure_reason')) { row = { ...row, failure_reason: p[1] }; return []; }
    if (sql.includes("set state = 'processing'")) { if (row.state === 'approved') row = { ...row, state: 'processing' }; return []; }
    if (sql.includes("set state = 'paid'")) {
      if (!['approved', 'processing'].includes(row.state)) return [];
      row = { ...row, state: 'paid', bank_reference: p[1] };
      return [row];
    }
    throw new Error(sql);
  });
  const ds: any = { query, transaction: async (cb: any) => cb({ query }) };
  const ledger: any = { payoutPaid: jest.fn() };
  const audit: any = { log: jest.fn() };
  return { svc: new PayoutService(ds, ledger, audit), ledger, get row() { return row; } };
}

describe('PayoutService state machine', () => {
  it('providers: manual awaits a human, cashfree is explicitly blocked (never simulated)', async () => {
    expect(await new ManualPayoutProvider().disburse()).toEqual({ status: 'processing' });
    expect(await new CashfreePayoutProvider().disburse()).toEqual({ status: 'blocked', reason: 'blocked: provider activation required' });
  });

  it('pending -> approved -> processing (manual) -> paid posts the payout ledger once', async () => {
    const t = payoutSetup();
    expect((await t.svc.approve('po1', 'admin')).state).toBe('processing');
    const paid = await t.svc.markPaid('po1', 'admin', 'UTR123456');
    expect(paid.state).toBe('paid');
    expect(t.ledger.payoutPaid).toHaveBeenCalledWith(expect.objectContaining({ amount: 940, reference: 'UTR123456' }), expect.anything());
    await expect(t.svc.markPaid('po1', 'admin', 'UTR123456')).rejects.toBeInstanceOf(ConflictException);
    expect(t.ledger.payoutPaid).toHaveBeenCalledTimes(1);
  });

  it('approving with the cashfree provider 409s with the activation message and leaves the payout approved', async () => {
    const t = payoutSetup();
    await expect(t.svc.approve('po1', 'admin', 'cashfree')).rejects.toThrow('provider activation required');
    expect(t.row.state).toBe('approved');
    expect(t.ledger.payoutPaid).not.toHaveBeenCalled();
  });

  it('cannot mark a pending payout paid, or approve twice', async () => {
    const t = payoutSetup();
    await expect(t.svc.markPaid('po1', 'admin', 'UTR123456')).rejects.toBeInstanceOf(ConflictException);
    await t.svc.approve('po1', 'admin');
    await expect(t.svc.approve('po1', 'admin')).rejects.toBeInstanceOf(ConflictException);
  });
});
