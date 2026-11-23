import { PaymentsReconciler } from './payments-reconciler.service';

function setup(opts: { bookingStatus: string; orderStatus: string | null }) {
  const stale = [{ id: 'p1', booking_id: 'b1', cashfree_order_id: 'bk_1' }];
  const payments: any = { listStalePending: jest.fn().mockResolvedValue(stale), closePendingOrder: jest.fn() };
  const cashfree: any = { fetchPgOrder: jest.fn().mockResolvedValue(opts.orderStatus ? { status: opts.orderStatus } : null) };
  const bookings: any = { syncPayment: jest.fn() };
  const refunds: any = { sweepable: jest.fn().mockResolvedValue([{ id: 'r1', state: 'requested' }, { id: 'r2', state: 'pending' }]), dispatch: jest.fn(), poll: jest.fn() };
  const flow: any = { onHeld: jest.fn() };
  const ds: any = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('from bookings')) return [{ status: opts.bookingStatus }];
      return [{ id: 'p9', booking_id: 'b9', amount: 10, cashfree_order_id: 'bk_9' }];
    }),
  };
  return { rec: new PaymentsReconciler(payments, cashfree, bookings, refunds, flow, ds), payments, bookings, refunds, flow };
}

describe('PaymentsReconciler', () => {
  it('syncs a stale pending payment on a live booking through the existing syncPayment path', async () => {
    const t = setup({ bookingStatus: 'confirmed', orderStatus: 'ACTIVE' });
    const s = await t.rec.run();
    expect(t.bookings.syncPayment).toHaveBeenCalledWith('b1');
    expect(s).toMatchObject({ stalePending: 1, synced: 1 });
  });

  it('PAID order on a cancelled booking goes through syncPayment (hold then real refund)', async () => {
    const t = setup({ bookingStatus: 'cancelled', orderStatus: 'PAID' });
    const s = await t.rec.run();
    expect(t.bookings.syncPayment).toHaveBeenCalledWith('b1');
    expect(s.refundedLate).toBe(1);
    expect(t.payments.closePendingOrder).not.toHaveBeenCalled();
  });

  it('ACTIVE order on a cancelled booking is terminated', async () => {
    const t = setup({ bookingStatus: 'cancelled', orderStatus: 'ACTIVE' });
    const s = await t.rec.run();
    expect(t.payments.closePendingOrder).toHaveBeenCalledWith('b1');
    expect(s.closed).toBe(1);
  });

  it('sweeps unsent and pending refunds and backfills missing held ledger entries', async () => {
    const t = setup({ bookingStatus: 'confirmed', orderStatus: 'ACTIVE' });
    const s = await t.rec.run();
    expect(t.refunds.dispatch).toHaveBeenCalledWith('r1');
    expect(t.refunds.poll).toHaveBeenCalledWith('r2');
    expect(t.flow.onHeld).toHaveBeenCalledTimes(1);
    expect(s).toMatchObject({ refundsDispatched: 1, refundsPolled: 1, ledgerBackfilled: 1, errors: 0 });
  });

  it('one failing payment does not stop the run', async () => {
    const t = setup({ bookingStatus: 'confirmed', orderStatus: 'ACTIVE' });
    t.bookings.syncPayment.mockRejectedValue(new Error('cashfree down'));
    const s = await t.rec.run();
    expect(s.errors).toBe(1);
    expect(s.refundsDispatched).toBe(1);
  });
});
