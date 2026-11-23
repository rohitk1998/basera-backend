import { ConflictException } from '@nestjs/common';
import { BookingEntity, DisputeCaseEntity, DisputeEventEntity } from '../entities';
import { BookingsService, generateBookingReference, PAY_BY_TTL_MS } from './bookings.service';
import { fakeDataSource } from './bookings.test-utils';

const ID = 'b1';
const GUEST = 'g1';
const HOST = 'h1';
const DAY = 24 * 3600 * 1000;

function qbReturning(result: unknown) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'andWhere']) qb[m] = jest.fn().mockReturnValue(qb);
  qb.getOne = jest.fn().mockResolvedValue(result);
  return qb;
}

interface Opts {
  booking?: Record<string, unknown>;
  overlap?: unknown;
  payment?: Record<string, unknown> | null;
  env?: Record<string, string>;
  insert?: jest.Mock;
  txFails?: unknown;
}

function makeBase(o: Opts = {}) {
  const qb = qbReturning(o.overlap ?? null);
  const bookingsRepo: Record<string, jest.Mock> = {
    findOne: jest.fn().mockResolvedValue({
      status: 'confirmed',
      guest_id: GUEST,
      host_id: HOST,
      listing_id: 'l1',
      move_in: '2026-12-01',
      move_out: '2026-12-05',
      pay_by_at: null,
      ...o.booking,
    }),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    insert: o.insert ?? jest.fn().mockResolvedValue({ identifiers: [{ id: 'new1' }] }),
  };
  const disputeCasesRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }), findOne: jest.fn() };
  const disputeEventsRepo = { insert: jest.fn().mockResolvedValue(undefined) };
  const repos = new Map<unknown, any>([
    [BookingEntity, bookingsRepo],
    [DisputeCaseEntity, disputeCasesRepo],
    [DisputeEventEntity, disputeEventsRepo],
  ]);
  const ds = fakeDataSource(repos);
  const payments = {
    getForBooking: jest.fn().mockResolvedValue(o.payment === undefined ? null : o.payment),
    release: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
    splitRelease: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn(),
    markHeld: jest.fn().mockResolvedValue(true),
  };
  const listingsRepo = { findOne: jest.fn().mockResolvedValue({ status: 'live', booking_eligible: true, host_id: HOST, draft_data: { property_details: { title: 'Loft', dailyBaseRate: 1000 } } }) };
  const profilesRepo = { findOne: jest.fn().mockResolvedValue({ id: GUEST, full_name: 'G', phone: '9876543210', email_verified_at: new Date() }) };
  const notifications = { notify: jest.fn() };
  const config = { get: jest.fn((k: string) => (k === 'PLATFORM_COMMISSION_PERCENTAGE' ? 6 : o.env?.[k])) };
  const cashfree = { fetchPgOrder: jest.fn().mockResolvedValue(null), fetchSuccessfulPaymentId: jest.fn() };
  const calendarSync = { assertDatesFree: jest.fn().mockResolvedValue(undefined) };
  const stub = { findOne: jest.fn().mockResolvedValue(null), insert: jest.fn() };
  const service = new BookingsService(
    bookingsRepo as never,
    ds.events as never,
    listingsRepo as never,
    profilesRepo as never,
    stub as never,
    disputeCasesRepo as never,
    disputeEventsRepo as never,
    notifications as never,
    payments as never,
    {} as never,
    ds.dataSource as never,
    config as never,
    cashfree as never,
    calendarSync as never,
  );
  return { service, bookingsRepo, payments, notifications, ds, qb, cashfree, disputeCasesRepo };
}

const makeService = makeBase;
const dto = {
  listingId: 'l1',
  moveIn: '2027-03-01',
  moveOut: '2027-03-15',
  paymentMethod: 'upi',
  idDisclaimerAccepted: true,
} as never;

describe('BookingsService.create (double-booking, reference, idempotency)', () => {
  const makeService = (o: Opts = {}) => {
    const m = makeBase(o);
    m.bookingsRepo.findOne.mockResolvedValue(null);
    return m;
  };

  it('takes a per-listing advisory lock before checking overlap and inserting, in one transaction', async () => {
    const { service, ds, qb, bookingsRepo } = makeService();
    const order: string[] = [];
    ds.query.mockImplementation(async (sql: string) => {
      if (sql.includes('listing_pricing')) return []; // turnover-buffer lookup, not part of the ordering under test
      order.push(sql.includes('advisory') ? 'lock' : 'q');
    });
    qb.getOne.mockImplementation(async () => {
      order.push('overlap');
      return null;
    });
    bookingsRepo.insert.mockImplementation(async () => (order.push('insert'), { identifiers: [{ id: 'new1' }] }));
    const res = await service.create(GUEST, dto);
    expect(ds.dataSource.transaction).toHaveBeenCalled();
    expect(order.slice(order.indexOf('lock'))).toEqual(['lock', 'overlap', 'insert']);
    expect(res).toMatchObject({ id: 'new1', status: 'requested', reference: expect.stringMatching(/^RB-[A-Z2-9]{6}$/) });
  });

  it('409s when a blocking booking overlaps and does not insert', async () => {
    const { service, bookingsRepo } = makeService({ overlap: { id: 'other' } });
    await expect(service.create(GUEST, dto)).rejects.toBeInstanceOf(ConflictException);
    expect(bookingsRepo.insert).not.toHaveBeenCalled();
  });

  it('maps a DB exclusion violation (23P01) to 409', async () => {
    const insert = jest.fn().mockRejectedValue(Object.assign(new Error('conflicting key'), { code: '23P01' }));
    const { service } = makeService({ insert });
    await expect(service.create(GUEST, dto)).rejects.toBeInstanceOf(ConflictException);
  });

  it('writes the reference and idempotency key on the row', async () => {
    const { service, bookingsRepo } = makeService();
    await service.create(GUEST, dto, ' key-1 ');
    expect(bookingsRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ idempotency_key: 'key-1', reference: expect.stringMatching(/^RB-/) }));
  });

  it('returns the existing booking on replay without inserting', async () => {
    const { service, bookingsRepo } = makeService();
    bookingsRepo.findOne.mockResolvedValueOnce({ id: 'old1', status: 'requested', reference: 'RB-AAAAAA' });
    const res = await service.create(GUEST, dto, 'key-1');
    expect(res).toMatchObject({ id: 'old1', reference: 'RB-AAAAAA', replayed: true });
    expect(bookingsRepo.insert).not.toHaveBeenCalled();
  });

  it('resolves a concurrent replay (unique violation on the idempotency index) to the winner', async () => {
    const insert = jest.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: '23505', constraint: 'bookings_guest_idempotency_key_uq' }));
    const { service, bookingsRepo } = makeService({ insert });
    bookingsRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'old1', status: 'requested', reference: 'RB-AAAAAA' });
    await expect(service.create(GUEST, dto, 'key-1')).resolves.toMatchObject({ id: 'old1', replayed: true });
  });

  it('retries with a new reference on a reference collision', async () => {
    const insert = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505', constraint: 'bookings_reference_key' }))
      .mockResolvedValue({ identifiers: [{ id: 'new1' }] });
    const { service } = makeService({ insert });
    await expect(service.create(GUEST, dto)).resolves.toMatchObject({ id: 'new1' });
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it('generates short references', () => {
    expect(generateBookingReference()).toMatch(/^RB-[A-Z2-9]{6}$/);
  });
});

describe('BookingsService.approve', () => {
  it('refuses to approve when the dates were taken meanwhile (requests never blocked)', async () => {
    const { service, bookingsRepo } = makeService({ booking: { status: 'requested' }, overlap: { id: 'other' } });
    await expect(service.approve(HOST, ID)).rejects.toBeInstanceOf(ConflictException);
    expect(bookingsRepo.update).not.toHaveBeenCalled();
  });

  it('locks the listing, excludes itself from the overlap, sets pay_by_at and logs the event in the same tx', async () => {
    const { service, bookingsRepo, qb, ds, notifications } = makeService({ booking: { status: 'requested' } });
    const before = Date.now();
    await service.approve(HOST, ID);
    expect(ds.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['l1']);
    expect(qb.andWhere).toHaveBeenCalledWith('b.id <> :excludeId', { excludeId: ID });
    const [where, patch] = bookingsRepo.update.mock.calls[0];
    expect(where).toEqual({ id: ID, status: 'requested' });
    expect(patch.status).toBe('confirmed');
    expect(patch.pay_by_at.getTime() - before).toBeGreaterThanOrEqual(PAY_BY_TTL_MS - 1000);
    expect(ds.events.insert).toHaveBeenCalledWith(expect.objectContaining({ from_status: 'requested', to_status: 'confirmed' }));
    expect(ds.manager.update).toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith('booking.confirmed', GUEST, expect.anything());
  });

  it('honours BOOKING_PAY_BY_HOURS', async () => {
    const { service, bookingsRepo } = makeService({ booking: { status: 'requested' }, env: { BOOKING_PAY_BY_HOURS: '2' } });
    await service.approve(HOST, ID);
    const { pay_by_at } = bookingsRepo.update.mock.calls[0][1];
    expect(pay_by_at.getTime() - Date.now()).toBeLessThan(2 * 3600_000 + 1000);
  });

  it('maps a DB exclusion violation during approve to 409', async () => {
    const { service, ds } = makeService({ booking: { status: 'requested' } });
    ds.manager.update.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '23P01' }));
    await expect(service.approve(HOST, ID)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rolls the status change back with its event: a failed event insert propagates out of the transaction', async () => {
    const { service, ds } = makeService({ booking: { status: 'requested' } });
    ds.events.insert.mockRejectedValueOnce(new Error('event insert failed'));
    await expect(service.approve(HOST, ID)).rejects.toThrow('event insert failed');
  });
});

describe('BookingsService.pay deadline / recheck', () => {
  it('rejects once pay_by_at has passed', async () => {
    const { service } = makeService({ booking: { pay_by_at: new Date(Date.now() - 1000) } });
    await expect(service.pay(GUEST, ID)).rejects.toThrow(/payment window/);
  });

  it('rejects if the dates are now blocked by another booking', async () => {
    const { service } = makeService({ overlap: { id: 'other' } });
    await expect(service.pay(GUEST, ID)).rejects.toThrow(/no longer available/);
  });
});

describe('BookingsService.cancel refund policy', () => {
  const soon = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10); // inside every policy's full-refund window
  const far = new Date(Date.now() + 40 * DAY).toISOString().slice(0, 10);

  it('guest cancelling inside the policy window gets the partial amount via splitRelease', async () => {
    const { service, payments, ds } = makeService({ booking: { move_in: soon }, payment: { status: 'held', amount: 10001 } });
    await service.cancel(GUEST, ID);
    expect(payments.refund).not.toHaveBeenCalled();
    expect(payments.splitRelease).toHaveBeenCalledWith(ID, 5000, ds.manager);
  });

  it('guest cancelling well ahead gets a full refund', async () => {
    const { service, payments, ds } = makeService({ booking: { move_in: far }, payment: { status: 'held', amount: 10001 } });
    await service.cancel(GUEST, ID);
    expect(payments.refund).toHaveBeenCalledWith(ID, ds.manager);
    expect(payments.splitRelease).not.toHaveBeenCalled();
  });

  it('host cancellation is always a full refund, even at the last minute', async () => {
    const { service, payments, ds } = makeService({ booking: { move_in: soon }, payment: { status: 'held', amount: 10001 } });
    await service.cancel(HOST, ID);
    expect(payments.refund).toHaveBeenCalledWith(ID, ds.manager);
    expect(payments.splitRelease).not.toHaveBeenCalled();
  });

  it('can cancel from the new offer states', async () => {
    for (const status of ['host_review', 'offered', 'awaiting_payment']) {
      const { service } = makeService({ booking: { status } });
      await expect(service.cancel(GUEST, ID)).resolves.toMatchObject({ status: 'cancelled' });
    }
  });
});

describe('BookingsService.cancel after payment', () => {
  it('refunds a held payment in the same transaction as the cancellation', async () => {
    const { service, payments, ds, bookingsRepo } = makeService({ payment: { status: 'held' } });
    await expect(service.cancel(GUEST, ID)).resolves.toMatchObject({ status: 'cancelled' });
    expect(payments.refund).toHaveBeenCalledWith(ID, ds.manager);
    expect(bookingsRepo.update).toHaveBeenCalledWith({ id: ID, status: 'confirmed' }, expect.objectContaining({ status: 'cancelled' }));
    expect(ds.events.insert).toHaveBeenCalledWith(expect.objectContaining({ to_status: 'cancelled', actor: GUEST }));
  });

  it('propagates (rolls back) when the refund loses a race', async () => {
    const { service, payments } = makeService({ payment: { status: 'held' } });
    payments.refund.mockRejectedValue(new ConflictException('released'));
    await expect(service.cancel(GUEST, ID)).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not refund when nothing was paid, and leaves a pending order for late-payment reconciliation', async () => {
    const { service, payments } = makeService({ payment: null });
    await service.cancel(HOST, ID);
    expect(payments.refund).not.toHaveBeenCalled();
    expect(payments.markFailed).not.toHaveBeenCalled();
  });

  it('settles a pending order first, so a just-paid booking is refunded', async () => {
    const { service, payments, cashfree } = makeService();
    payments.getForBooking
      .mockResolvedValueOnce({ status: 'pending', cashfree_order_id: 'o1', amount: 100 }) // cancel
      .mockResolvedValueOnce({ status: 'pending', cashfree_order_id: 'o1', amount: 100 }) // syncPayment
      .mockResolvedValue({ status: 'held' });
    cashfree.fetchPgOrder.mockResolvedValue({ status: 'PAID', amount: 100, currency: 'INR', orderId: 'o1' });
    await service.cancel(GUEST, ID);
    expect(payments.refund).toHaveBeenCalledWith(ID, expect.anything());
  });

  it('cannot cancel a checked-in booking', async () => {
    const { service } = makeService({ booking: { status: 'checked_in' } });
    await expect(service.cancel(GUEST, ID)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('late payment on a closed booking', () => {
  it('auto-refunds a PAID order whose booking is cancelled instead of ignoring it', async () => {
    const { service, payments, cashfree } = makeService({ booking: { status: 'cancelled' } });
    payments.getForBooking.mockResolvedValue({ status: 'pending', cashfree_order_id: 'o1', amount: 100 });
    cashfree.fetchPgOrder.mockResolvedValue({ status: 'PAID', amount: 100, currency: 'INR', orderId: 'o1' });
    await expect(service.syncPayment(ID)).resolves.toBe('held');
    expect(payments.refund).toHaveBeenCalledWith(ID);
  });
});

describe('BookingsService.releaseHold race with dispute', () => {
  it('releases payment and completes the booking in one transaction', async () => {
    const { service, payments, ds } = makeService({ booking: { status: 'checked_in' } });
    await service.releaseHold(ID);
    expect(ds.dataSource.transaction).toHaveBeenCalled();
    expect(payments.release).toHaveBeenCalledWith(ID, ds.manager);
  });

  it('backs off without touching the payment when a dispute won the booking CAS', async () => {
    const { service, payments, bookingsRepo } = makeService({ booking: { status: 'checked_in' } });
    bookingsRepo.update.mockResolvedValue({ affected: 0 });
    await expect(service.releaseHold(ID)).resolves.toBeUndefined();
    expect(payments.release).not.toHaveBeenCalled();
  });

  it('propagates (rolling back the completion) when the payment is no longer held', async () => {
    const { service, payments } = makeService({ booking: { status: 'checked_in' } });
    payments.release.mockRejectedValue(new ConflictException('not held'));
    await expect(service.releaseHold(ID)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('BookingsService.resolveDispute transaction', () => {
  it('runs split, completion, event and case update in one transaction, and surfaces a failure', async () => {
    const { service, payments, disputeCasesRepo, ds, bookingsRepo } = makeService({ booking: { status: 'disputed', move_in: '2026-10-14', move_out: '2026-10-21' } });
    disputeCasesRepo.findOne.mockResolvedValue({ id: 'c1', case_status: 'escalated', leaving_on: null, category: 'x' });
    (payments as any).splitRelease = jest.fn().mockRejectedValue(new ConflictException('not held'));
    await expect(service.resolveDispute('a1', ID, 10, undefined)).rejects.toBeInstanceOf(ConflictException);
    expect(ds.dataSource.transaction).toHaveBeenCalledTimes(1);
    // completion happened on the tx manager only, so the rolled-back tx leaves no committed state
    expect(ds.manager.update).toHaveBeenCalledWith(BookingEntity, expect.anything(), expect.anything());
    expect(bookingsRepo.update).toHaveBeenCalledTimes(1);
  });
});

describe('BookingsService.expireStaleHolds pay-by deadline', () => {
  function withOverdue(o: Opts, overdue: unknown[]) {
    const m = makeService(o);
    m.bookingsRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce(overdue);
    return m;
  }

  it('expires an unpaid confirmed booking past pay_by_at and notifies the guest', async () => {
    const { service, bookingsRepo, notifications } = withOverdue({ payment: null }, [{ id: ID, guest_id: GUEST }]);
    await expect(service.expireStaleHolds()).resolves.toBe(1);
    expect(bookingsRepo.update).toHaveBeenCalledWith({ id: ID, status: 'confirmed' }, expect.objectContaining({ status: 'expired' }));
    expect(notifications.notify).toHaveBeenCalledWith('booking.expired', GUEST, expect.anything());
  });

  it('leaves a paid (held) booking alone', async () => {
    const { service, bookingsRepo } = withOverdue({ payment: { status: 'held' } }, [{ id: ID, guest_id: GUEST }]);
    await expect(service.expireStaleHolds()).resolves.toBe(0);
    expect(bookingsRepo.update).not.toHaveBeenCalled();
  });

  it('skips when the booking moved on during the CAS', async () => {
    const { service, bookingsRepo } = withOverdue({ payment: null }, [{ id: ID, guest_id: GUEST }]);
    bookingsRepo.update.mockResolvedValue({ affected: 0 });
    await expect(service.expireStaleHolds()).resolves.toBe(0);
  });

  it('queries only confirmed bookings with an elapsed pay_by_at', async () => {
    const { service, bookingsRepo } = withOverdue({}, []);
    await service.expireStaleHolds();
    const where = bookingsRepo.find.mock.calls[1][0].where;
    expect(where.status._value).toEqual(['confirmed', 'awaiting_payment']);
    expect(where.pay_by_at).toBeDefined();
  });
});

describe('BookingsService.adminCancel', () => {
  const far = new Date(Date.now() + 40 * DAY).toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
  const ADMIN = 'adm1';

  it('full refund: refunds in the transaction, records an admin-actor event, notifies guest and host with dedupeKey', async () => {
    const { service, payments, ds, notifications, bookingsRepo } = makeService({ booking: { move_in: soon }, payment: { status: 'held', amount: 10000 } });
    const r = await service.adminCancel(ADMIN, ID, { reason: 'Property unsafe', refundMode: 'full' });
    expect(r).toMatchObject({ status: 'cancelled', refundedToGuest: 10000 });
    expect(payments.refund).toHaveBeenCalledWith(ID, ds.manager);
    expect(bookingsRepo.update).toHaveBeenCalledWith({ id: ID, status: 'confirmed' }, expect.objectContaining({ status: 'cancelled' }));
    expect(ds.events.insert).toHaveBeenCalledWith(expect.objectContaining({ to_status: 'cancelled', actor: ADMIN }));
    expect(notifications.notify).toHaveBeenCalledTimes(2);
    expect(notifications.notify).toHaveBeenCalledWith('booking.cancelled', GUEST, expect.anything(), { dedupeKey: `admin-cancel:${ID}` });
    expect(notifications.notify).toHaveBeenCalledWith('booking.cancelled', HOST, expect.anything(), { dedupeKey: `admin-cancel:${ID}` });
  });

  it('policy mode applies the cancellation-policy split', async () => {
    const { service, payments, ds } = makeService({ booking: { move_in: soon }, payment: { status: 'held', amount: 10001 } });
    await service.adminCancel(ADMIN, ID, { reason: 'Host unreachable', refundMode: 'policy' });
    expect(payments.splitRelease).toHaveBeenCalledWith(ID, 5000, ds.manager);
  });

  it('policy mode far ahead is a full refund', async () => {
    const { service, payments } = makeService({ booking: { move_in: far }, payment: { status: 'held', amount: 10001 } });
    await service.adminCancel(ADMIN, ID, { reason: 'Host unreachable', refundMode: 'policy' });
    expect(payments.refund).toHaveBeenCalled();
  });

  it('none mode needs a 10+ char reason and refunds nothing (guest share 0)', async () => {
    const { service, payments, ds } = makeService({ payment: { status: 'held', amount: 10000 } });
    await expect(service.adminCancel(ADMIN, ID, { reason: 'short', refundMode: 'none' })).rejects.toThrow(/10 characters/);
    await service.adminCancel(ADMIN, ID, { reason: 'Guest abuse confirmed', refundMode: 'none' });
    expect(payments.refund).not.toHaveBeenCalled();
    expect(payments.splitRelease).toHaveBeenCalledWith(ID, 0, ds.manager);
  });

  it.each(['checked_in', 'completed', 'disputed', 'checked_out'])('409 for %s and no state change', async (status) => {
    const { service, bookingsRepo, payments } = makeService({ booking: { status } });
    await expect(service.adminCancel(ADMIN, ID, { reason: 'because reasons', refundMode: 'full' })).rejects.toBeInstanceOf(ConflictException);
    expect(bookingsRepo.update).not.toHaveBeenCalled();
    expect(payments.refund).not.toHaveBeenCalled();
  });

  it('404 for a missing booking', async () => {
    const { service, bookingsRepo } = makeService();
    bookingsRepo.findOne.mockResolvedValue(null);
    await expect(service.adminCancel(ADMIN, ID, { reason: 'because reasons', refundMode: 'full' })).rejects.toThrow(/not found/);
  });
});

describe('BookingsService turnover buffer', () => {
  function withBuffer(days: number | null, occupied: Array<{ move_in: string; move_out: string }>) {
    const m = makeBase({ booking: { status: 'confirmed', move_in: '2026-12-10', move_out: '2026-12-12' } });
    m.ds.query.mockImplementation(async (sql: string) => {
      if (sql.includes('to_regclass')) return [{ ok: days !== null }];
      if (sql.includes('buffer_days')) return [{ buffer_days: days }];
      return [];
    });
    const qb: Record<string, jest.Mock> = {};
    for (const k of ['where', 'andWhere']) qb[k] = jest.fn().mockReturnValue(qb);
    qb.getOne = jest.fn().mockResolvedValue(null);
    qb.getMany = jest.fn().mockResolvedValue(occupied);
    m.bookingsRepo.createQueryBuilder.mockReturnValue(qb);
    return m;
  }

  it('pay() refuses a stay that touches a neighbour inside the buffer', async () => {
    // neighbour leaves 2026-12-09; buffer 2 days => blocked through 12-11, request starts 12-10
    const { service } = withBuffer(2, [{ move_in: '2026-12-05', move_out: '2026-12-09' }]);
    await expect(service.pay(GUEST, ID)).rejects.toThrow(/no longer available/);
  });

  it('pay() allows it with buffer 0 or no listing_pricing row', async () => {
    for (const d of [0, null]) {
      const { service } = withBuffer(d, [{ move_in: '2026-12-05', move_out: '2026-12-09' }]);
      await expect(service.pay(GUEST, ID)).rejects.not.toThrow(/no longer available/);
    }
  });
});
