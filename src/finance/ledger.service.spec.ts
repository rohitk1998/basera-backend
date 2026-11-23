import { InternalServerErrorException } from '@nestjs/common';
import { fakeLedgerDb } from './finance.test-utils';
import { groupIdFor, LedgerService } from './ledger.service';

describe('LedgerService', () => {
  it('groupIdFor is deterministic and uuid-shaped', () => {
    expect(groupIdFor('k')).toBe(groupIdFor('k'));
    expect(groupIdFor('k')).not.toBe(groupIdFor('k2'));
    expect(groupIdFor('k')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('rejects an unbalanced post before touching the DB', async () => {
    const db = fakeLedgerDb();
    const svc = new LedgerService(db.ds);
    await expect(
      svc.record({ idemKey: 'x', kind: 'x', lines: [{ account: 'platform_cash', debit: 10 }, { account: 'guest_receivable', credit: 9 }] }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('is idempotent: replaying the same key (webhook replay) never double-posts', async () => {
    const db = fakeLedgerDb();
    const svc = new LedgerService(db.ds);
    const args = { paymentId: 'p1', bookingId: 'b1', amount: 1000 };
    expect((await svc.paymentHeld(args)).posted).toBe(true);
    expect((await svc.paymentHeld(args)).posted).toBe(false);
    expect(db.rows).toHaveLength(2);
    expect(db.balance('platform_cash')).toBe(-1000); // debit-normal: cash in
    expect(db.groupsBalanced()).toBe(true);
  });

  it('full lifecycle with commission balances: held -> release (6%) -> payout paid', async () => {
    const db = fakeLedgerDb();
    const svc = new LedgerService(db.ds);
    await svc.paymentHeld({ paymentId: 'p', bookingId: 'b', amount: 1000 });
    await svc.hostShare({ kind: 'release', paymentId: 'p', bookingId: 'b', hostId: 'h', base: 1000, commission: 60 });
    expect(db.balance('host_payable')).toBe(940);
    expect(db.balance('platform_commission')).toBe(60);
    expect(db.balance('guest_receivable')).toBe(0);
    await svc.payoutPaid({ payoutId: 'po', paymentId: 'p', bookingId: 'b', hostId: 'h', amount: 940 });
    expect(db.balance('host_payable')).toBe(0);
    expect(-db.balance('platform_cash')).toBe(60); // only the commission is left in platform cash
    expect(db.groupsBalanced()).toBe(true);
  });

  it('zero commission (free period) posts no commission line', async () => {
    const db = fakeLedgerDb();
    await new LedgerService(db.ds).hostShare({ kind: 'release', paymentId: 'p', bookingId: 'b', hostId: 'h', base: 500, commission: 0 });
    expect(db.rows.map((r) => r.account).sort()).toEqual(['guest_receivable', 'host_payable']);
  });

  it('refund request -> settled and request -> failed reversal both balance', async () => {
    const db = fakeLedgerDb();
    const svc = new LedgerService(db.ds);
    await svc.paymentHeld({ paymentId: 'p', bookingId: 'b', amount: 1000 });
    const r = { refundId: 'r1', paymentId: 'p', bookingId: 'b', amount: 400 };
    await svc.refundRequested({ ...r, generation: 0 });
    await svc.refundFailed({ ...r, generation: 0 });
    expect(db.balance('refunds')).toBe(0);
    expect(db.balance('guest_receivable')).toBe(1000);
    await svc.refundRequested({ ...r, generation: 1 });
    await svc.refundSettled(r);
    expect(db.balance('guest_receivable')).toBe(600);
    expect(-db.balance('platform_cash')).toBe(600);
    expect(db.groupsBalanced()).toBe(true);
  });

  it('adjustments credit/debit host_payable against the adjustments account', async () => {
    const db = fakeLedgerDb();
    const svc = new LedgerService(db.ds);
    await svc.adjustment({ id: 'a1', hostId: 'h', direction: 'host_credit', amount: 50 });
    await svc.adjustment({ id: 'a2', hostId: 'h', direction: 'host_debit', amount: 20 });
    expect(db.balance('host_payable')).toBe(30);
    expect(db.balance('adjustments')).toBe(-30);
    expect(db.groupsBalanced()).toBe(true);
  });
});
