import { InternalServerErrorException } from '@nestjs/common';
import { PaymentsService } from './payments.service';

function makeService(payment: Record<string, unknown> | null, rawRows: Record<string, unknown>[] = []) {
  const paymentsRepo = {
    findOne: jest.fn().mockResolvedValue(payment),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['innerJoin', 'leftJoin', 'select', 'where', 'orderBy']) qb[m] = jest.fn().mockReturnValue(qb);
  qb.getRawMany = jest.fn().mockResolvedValue(rawRows);
  const dataSource = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  return { service: new PaymentsService(paymentsRepo as never, dataSource as never), paymentsRepo };
}

describe('PaymentsService.splitRelease', () => {
  it('records the guest refund and leaves the rest to the host, as status split', async () => {
    const { service, paymentsRepo } = makeService({ id: 'p1', amount: 10500, status: 'held' });
    await service.splitRelease('b1', 7500);
    expect(paymentsRepo.update).toHaveBeenCalledWith(
      { id: 'p1' },
      expect.objectContaining({ status: 'split', split_amount_to_guest: 7500 }),
    );
  });

  it('rejects an amount above what was paid', async () => {
    const { service, paymentsRepo } = makeService({ id: 'p1', amount: 10500, status: 'held' });
    await expect(service.splitRelease('b1', 10501)).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(paymentsRepo.update).not.toHaveBeenCalled();
  });

  it('rejects a negative amount', async () => {
    const { service } = makeService({ id: 'p1', amount: 10500, status: 'held' });
    await expect(service.splitRelease('b1', -1)).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

describe('PaymentsService.listTransactions', () => {
  const base = { id: 'p1', cashfreeOrderId: 'o1', cashfreePayoutId: 'SIMULATED-x', bookingId: 'b1' };

  it('reports refunded and host amounts for a split payment', async () => {
    const { service } = makeService(null, [{ ...base, amount: 10500, status: 'split', splitAmountToGuest: 7500 }]);
    const res = await service.listTransactions('g1', 'guest');
    expect(res.transactions[0]).toMatchObject({ amount: 10500, status: 'split', refundedAmount: 7500, hostAmount: 3000 });
  });

  it('has no split amounts for a plain release', async () => {
    const { service } = makeService(null, [{ ...base, amount: 1500, status: 'released_to_host', splitAmountToGuest: null }]);
    const res = await service.listTransactions('g1', 'guest');
    expect(res.transactions[0]).toMatchObject({ refundedAmount: null, hostAmount: null });
  });
});
