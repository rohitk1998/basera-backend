import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { cashfreeRefundId, parseCashfreeRefundId, RefundService, mapRefundStatus } from './refund.service';

const PAYMENT = { id: 'a0000000-0000-0000-0000-000000000001', booking_id: 'b1', amount: 1000, cashfree_order_id: 'bk_b1_1' };

/** Tiny in-memory refunds table behind a regex SQL router. */
function setup(order = PAYMENT.cashfree_order_id) {
  const table: any[] = [];
  let n = 0;
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    if (sql.includes("sum(amount) filter (where state <> 'failed')")) {
      return [{ requested: table.filter((r) => r.payment_id === p[0] && r.state !== 'failed').reduce((s, r) => s + r.amount, 0) }];
    }
    if (sql.startsWith('insert into refunds')) {
      const r = { id: `c0000000-0000-0000-0000-00000000000${++n}`, booking_id: p[0], payment_id: p[1], amount: p[2], state: p[3], provider: p[4], reason: p[5], attempts: 0, cf_refund_status: null, failure_reason: null };
      table.push(r);
      return [r];
    }
    if (sql.includes('join payments p on p.id = r.payment_id')) {
      const r = table.find((x) => x.id === p[0]);
      return r ? [{ ...r, cashfree_order_id: order }] : [];
    }
    if (sql.startsWith('update refunds set cf_refund_id')) return [];
    if (sql.includes('set failure_reason = $2')) {
      table.find((x) => x.id === p[0]).failure_reason = p[1];
      return [];
    }
    if (sql.includes('set state = $2')) {
      const r = table.find((x) => x.id === p[0]);
      if (!r || !['requested', 'pending'].includes(r.state) || r.state === p[1]) return [];
      Object.assign(r, { state: p[1], cf_refund_status: p[2] });
      return [{ ...r }];
    }
    if (sql.startsWith('select * from refunds')) return table.filter((x) => x.id === p[0]);
    if (sql.includes("set state = 'requested', attempts = attempts + 1")) {
      const r = table.find((x) => x.id === p[0] && x.state === 'failed' && x.provider === 'cashfree');
      if (!r) return [];
      Object.assign(r, { state: 'requested', attempts: r.attempts + 1 });
      return [{ ...r }];
    }
    throw new Error('unexpected sql: ' + sql.slice(0, 80));
  });
  const ds: any = { query, transaction: async (cb: any) => cb({ query }) };
  const cashfree: any = { createRefund: jest.fn(async (_o, id, amount) => ({ refundId: id, cfRefundId: '9', status: 'PENDING', amount })), getRefund: jest.fn() };
  const ledger: any = { refundRequested: jest.fn(), refundSettled: jest.fn(), refundFailed: jest.fn() };
  const audit: any = { log: jest.fn() };
  return { svc: new RefundService(ds, cashfree, ledger, audit), table, cashfree, ledger };
}

describe('refund id helpers', () => {
  it('round-trips ids and generations', () => {
    const id = 'c0000000-0000-0000-0000-000000000001';
    expect(parseCashfreeRefundId(cashfreeRefundId(id, 0))).toEqual({ id, generation: 0 });
    expect(parseCashfreeRefundId(cashfreeRefundId(id, 3))).toEqual({ id, generation: 3 });
    expect(parseCashfreeRefundId('garbage')).toBeNull();
    expect(cashfreeRefundId(id, 2).length).toBeLessThanOrEqual(55);
  });
  it('maps cashfree statuses', () => {
    expect([mapRefundStatus('SUCCESS'), mapRefundStatus('CANCELLED'), mapRefundStatus('FAILED'), mapRefundStatus('PENDING'), mapRefundStatus('ONHOLD')]).toEqual(['success', 'failed', 'failed', 'pending', 'pending']);
  });
});

describe('RefundService', () => {
  it('partial refund: creates a row, posts the ledger and calls Cashfree with the partial amount', async () => {
    const { svc, cashfree, ledger, table } = setup();
    const r = await svc.request(PAYMENT, 400, { reason: 'Guest cancelled' });
    expect(cashfree.createRefund).toHaveBeenCalledWith('bk_b1_1', cashfreeRefundId(r.id, 0), 400, 'Guest cancelled');
    expect(ledger.refundRequested).toHaveBeenCalledWith(expect.objectContaining({ amount: 400, generation: 0 }), undefined);
    expect(table[0].state).toBe('pending'); // gateway answered PENDING
    expect(ledger.refundSettled).not.toHaveBeenCalled();
  });

  it('refuses to refund more than was paid, counting earlier non-failed refunds', async () => {
    const { svc } = setup();
    await svc.request(PAYMENT, 700);
    await expect(svc.request(PAYMENT, 400)).rejects.toBeInstanceOf(ConflictException);
  });

  it('legacy/simulated payments settle immediately without calling Cashfree', async () => {
    const { svc, cashfree, ledger, table } = setup();
    await svc.request({ ...PAYMENT, cashfree_order_id: 'SIMULATED-x' }, 1000);
    expect(cashfree.createRefund).not.toHaveBeenCalled();
    expect(table[0]).toMatchObject({ state: 'success', provider: 'legacy' });
    expect(ledger.refundSettled).toHaveBeenCalledTimes(1);
  });

  it('gateway SUCCESS settles; a replayed success webhook posts the ledger only once', async () => {
    const { svc, ledger, table } = setup();
    const r = await svc.request(PAYMENT, 300);
    const hook = { refund_id: cashfreeRefundId(r.id, 0), refund_status: 'SUCCESS' };
    await svc.handleWebhook(hook);
    await svc.handleWebhook(hook);
    expect(table[0].state).toBe('success');
    expect(ledger.refundSettled).toHaveBeenCalledTimes(1);
  });

  it('gateway failure via webhook marks failed and reverses the ledger', async () => {
    const { svc, ledger, table } = setup();
    const r = await svc.request(PAYMENT, 300);
    await svc.handleWebhook({ refund_id: cashfreeRefundId(r.id, 0), refund_status: 'CANCELLED', status_description: 'bank rejected' });
    expect(table[0].state).toBe('failed');
    expect(ledger.refundFailed).toHaveBeenCalledWith(expect.objectContaining({ amount: 300, generation: 0 }), expect.anything());
  });

  it('a 4xx rejection from Cashfree fails the refund immediately; a transport error leaves it requested for the sweep', async () => {
    const a = setup();
    a.cashfree.createRefund.mockRejectedValueOnce(Object.assign(new ServiceUnavailableException('no'), { cashfreeStatus: 400 }));
    await a.svc.request(PAYMENT, 100);
    expect(a.table[0].state).toBe('failed');

    const b = setup();
    b.cashfree.createRefund.mockRejectedValueOnce(new ServiceUnavailableException('down'));
    await b.svc.request(PAYMENT, 100);
    expect(b.table[0].state).toBe('requested');
    expect(b.table[0].failure_reason).toBe('down');
  });

  it('webhooks for unknown or stale-generation refund ids are ignored', async () => {
    const { svc, table } = setup();
    expect(await svc.handleWebhook({ refund_id: 'nope', refund_status: 'SUCCESS' })).toBeNull();
    const r = await svc.request(PAYMENT, 100);
    expect(await svc.handleWebhook({ refund_id: cashfreeRefundId(r.id, 1), refund_status: 'SUCCESS' })).toBeNull();
    expect(table[0].state).toBe('pending');
  });

  it('retry: only failed cashfree refunds, new refund_id generation, ledger re-requested', async () => {
    const { svc, cashfree, ledger, table } = setup();
    const r = await svc.request(PAYMENT, 200);
    await expect(svc.retry(r.id, 'admin')).rejects.toBeInstanceOf(ConflictException);
    await svc.handleWebhook({ refund_id: cashfreeRefundId(r.id, 0), refund_status: 'FAILED' });
    await svc.retry(r.id, 'admin');
    expect(cashfree.createRefund).toHaveBeenLastCalledWith('bk_b1_1', cashfreeRefundId(r.id, 1), 200, expect.any(String));
    expect(ledger.refundRequested).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 1 }), expect.anything());
    expect(table[0].attempts).toBe(1);
  });

  it('poll syncs a pending refund from getRefund', async () => {
    const { svc, cashfree, table } = setup();
    const r = await svc.request(PAYMENT, 100);
    cashfree.getRefund.mockResolvedValueOnce({ refundId: 'x', cfRefundId: '1', status: 'SUCCESS', amount: 100 });
    await svc.poll(r.id);
    expect(table[0].state).toBe('success');
  });

  it('rejects non-positive or fractional amounts', async () => {
    const { svc } = setup();
    await expect(svc.request(PAYMENT, 0)).rejects.toThrow();
    await expect(svc.request(PAYMENT, 10.5)).rejects.toThrow();
  });
});
