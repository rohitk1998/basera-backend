import { PaymentsService } from './payments.service';

function setup(payment: any, cashfreeStatus: string | null = 'TERMINATED') {
  const repo: any = { findOne: jest.fn().mockResolvedValue(payment), update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const finance: any = { onHeld: jest.fn(), onRelease: jest.fn(), onRefund: jest.fn(), onSplit: jest.fn() };
  const cashfree: any = { terminateOrder: jest.fn().mockResolvedValue(cashfreeStatus) };
  const svc = new PaymentsService(repo, {} as any, finance, cashfree);
  return { svc, repo, finance, cashfree };
}
const held = { id: 'p1', booking_id: 'b1', amount: 1000, status: 'held', cashfree_order_id: 'bk_1' };

describe('PaymentsService finance integration', () => {
  it('release no longer writes SIMULATED payout ids and posts the release', async () => {
    const t = setup(held);
    await t.svc.release('b1');
    expect(t.repo.update.mock.calls[0][1]).toEqual(expect.objectContaining({ status: 'released_to_host' }));
    expect(JSON.stringify(t.repo.update.mock.calls[0][1])).not.toContain('SIMULATED');
    expect(t.finance.onRelease).toHaveBeenCalledWith(held, undefined);
  });

  it('refund defaults to the full amount; partial amount accepted as 2nd or 3rd argument', async () => {
    const t = setup(held);
    await t.svc.refund('b1');
    expect(t.finance.onRefund).toHaveBeenLastCalledWith(held, 1000, expect.anything());
    await t.svc.refund('b1', 300);
    expect(t.finance.onRefund).toHaveBeenLastCalledWith(held, 300, expect.anything());
    await t.svc.refund('b1', undefined, 400);
    expect(t.finance.onRefund).toHaveBeenLastCalledWith(held, 400, expect.anything());
  });

  it('refund validates the amount before changing status', async () => {
    const t = setup(held);
    await expect(t.svc.refund('b1', 5000)).rejects.toThrow();
    expect(t.repo.update).not.toHaveBeenCalled();
  });

  it('a lost status race (409) posts nothing', async () => {
    const t = setup(held);
    t.repo.update.mockResolvedValue({ affected: 0 });
    await expect(t.svc.refund('b1')).rejects.toThrow();
    expect(t.finance.onRefund).not.toHaveBeenCalled();
  });

  it('splitRelease passes the previous award only when re-deciding a split', async () => {
    const t = setup(held);
    await t.svc.splitRelease('b1', 200);
    expect(t.finance.onSplit).toHaveBeenLastCalledWith(held, 200, undefined, null);
    const split = { ...held, status: 'split', split_amount_to_guest: 100 };
    const t2 = setup(split);
    await t2.svc.splitRelease('b1', 200, undefined, ['split']);
    expect(t2.finance.onSplit).toHaveBeenLastCalledWith(split, 200, undefined, 100);
  });

  it('markHeld posts the held ledger entry only for the caller that flipped the row', async () => {
    const t = setup(held);
    expect(await t.svc.markHeld('b1', 'cf1')).toBe(true);
    expect(t.finance.onHeld).toHaveBeenCalledTimes(1);
    t.repo.update.mockResolvedValue({ affected: 0 });
    await t.svc.markHeld('b1', 'cf1');
    expect(t.finance.onHeld).toHaveBeenCalledTimes(1);
  });

  it('markHeld survives a ledger failure (reconcile backfills)', async () => {
    const t = setup(held);
    t.finance.onHeld.mockRejectedValue(new Error('db'));
    await expect(t.svc.markHeld('b1', null)).resolves.toBe(true);
  });

  describe('closePendingOrder', () => {
    const pending = { ...held, status: 'pending' };
    it('terminates the Cashfree order and marks the payment failed', async () => {
      const t = setup(pending);
      expect(await t.svc.closePendingOrder('b1')).toBe('closed');
      expect(t.cashfree.terminateOrder).toHaveBeenCalledWith('bk_1');
      expect(t.repo.update).toHaveBeenCalledWith({ booking_id: 'b1', status: 'pending' }, expect.objectContaining({ status: 'failed' }));
    });
    it('leaves the payment pending when the order was already PAID (so it is held then refunded)', async () => {
      const t = setup(pending, 'PAID');
      expect(await t.svc.closePendingOrder('b1')).toBe('paid');
      expect(t.repo.update).not.toHaveBeenCalled();
    });
    it('does nothing for non-pending, simulated or missing payments', async () => {
      expect(await setup(held).svc.closePendingOrder('b1')).toBe('none');
      expect(await setup({ ...pending, cashfree_order_id: 'SIMULATED-1' }).svc.closePendingOrder('b1')).toBe('none');
      expect(await setup(null).svc.closePendingOrder('b1')).toBe('none');
    });
  });
});
