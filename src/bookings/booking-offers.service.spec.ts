import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { BookingEntity, BookingEventEntity, BookingOfferEntity } from '../entities';
import { BookingOffersService } from './booking-offers.service';
import { BookingOffersScheduler } from './booking-offers.scheduler';
import { INSTANT_BOOKING_ENABLED } from './bookings.service';
import { computePriceSnapshot } from './offer-pricing.util';

const HOST = 'h1';
const GUEST = 'g1';
const BID = 'b1';
const HOUR = 3600_000;

const listing = {
  id: 'l1',
  status: 'live',
  is_discovered: false,
  booking_eligible: true,
  draft_data: { property_details: { title: 'Loft', dailyBaseRate: 1000, weeklyDiscountPct: 15, monthlyDiscountPct: 40 } },
};

function setup(o: { booking?: Partial<BookingEntity>; offers?: any[]; overlap?: boolean; env?: Record<string, any>; listing?: any } = {}) {
  const booking: any = {
    id: BID,
    listing_id: 'l1',
    guest_id: GUEST,
    host_id: HOST,
    status: 'requested',
    move_in: '2027-06-01',
    move_out: '2027-06-04',
    adults: 2,
    children: 0,
    payment_method: 'upi',
    pay_by_at: null,
    ...o.booking,
  };
  const offers: any[] = o.offers ? [...o.offers] : [];
  const events: any[] = [];
  const qb: any = {};
  for (const m of ['where', 'andWhere', 'limit']) qb[m] = jest.fn().mockReturnValue(qb);
  qb.getOne = jest.fn().mockResolvedValue(o.overlap ? { id: 'other' } : null);
  qb.getMany = jest.fn().mockResolvedValue([]);
  const bookingRepo: any = {
    findOne: jest.fn(async () => booking),
    createQueryBuilder: jest.fn(() => qb),
  };
  const offerRepo: any = {
    findOne: jest.fn(async ({ where }: any) =>
      offers.find((x) => Object.entries(where).every(([k, v]) => x[k] === v)) ?? null),
    find: jest.fn(async ({ where }: any) =>
      offers.filter((x) => Object.entries(where).every(([k, v]) => x[k] === v)).sort((a, b) => b.version - a.version)),
    create: jest.fn((x: any) => x),
    save: jest.fn(async (x: any) => {
      if (offers.some((p) => p.booking_id === x.booking_id && p.state === 'pending')) {
        throw Object.assign(new Error('dup'), { code: '23505', constraint: 'booking_offers_one_pending_uq' });
      }
      const row = { id: `o${offers.length + 1}`, created_at: new Date(), ...x };
      offers.push(row);
      return row;
    }),
    createQueryBuilder: jest.fn(() => qb),
  };
  const eventRepo = { insert: jest.fn(async (e: any) => void events.push(e)) };
  const repos = new Map<unknown, any>([[BookingEntity, bookingRepo], [BookingOfferEntity, offerRepo], [BookingEventEntity, eventRepo]]);
  const manager: any = {
    query: jest.fn().mockResolvedValue([]),
    getRepository: jest.fn((e: unknown) => repos.get(e)),
    update: jest.fn(async (e: unknown, where: any, set: any) => {
      if (e === BookingEntity) {
        if (booking.status !== where.status) return { affected: 0 };
        Object.assign(booking, set);
        return { affected: 1 };
      }
      const rows = offers.filter((x) => Object.entries(where).every(([k, v]) => x[k] === v));
      rows.forEach((r) => Object.assign(r, set));
      return { affected: rows.length };
    }),
  };
  const dataSource: any = {
    transaction: jest.fn(async (cb: any) => cb(manager)),
    getRepository: jest.fn((e: unknown) => repos.get(e)),
  };
  const listingsRepo: any = { findOne: jest.fn().mockResolvedValue(o.listing ?? listing) };
  const notifications = { notify: jest.fn() };
  const config = { get: jest.fn((k: string) => (k === 'PLATFORM_COMMISSION_PERCENTAGE' ? 6 : o.env?.[k])) };
  const calendarSync = { assertDatesFree: jest.fn().mockResolvedValue(undefined) };
  const service = new BookingOffersService(dataSource, listingsRepo, config as never, notifications as never, calendarSync as never);
  return { service, booking, offers, events, manager, dataSource, notifications, qb, offerRepo, calendarSync };
}

const computed = computePriceSnapshot({ dailyBaseRate: 1000, weeklyDiscountPct: 15, monthlyDiscountPct: 40 }, 3, 2).computedTotal; // 3000

describe('BookingOffersService.createOffer', () => {
  it('requested -> offered with a server-computed snapshot and an audit event', async () => {
    const { service, booking, events, notifications } = setup();
    const r = await service.createOffer(HOST, BID, { conditions: 'No parties' }, 'k1');
    expect(booking.status).toBe('offered');
    expect(r.offer.total).toBe(computed);
    expect(r.offer.priceSnapshot).toMatchObject({ nights: 3, subtotal: 3000, currency: 'INR', computedTotal: 3000 });
    expect(events).toContainEqual(expect.objectContaining({ from_status: 'requested', to_status: 'offered', actor: HOST }));
    expect(notifications.notify).toHaveBeenCalledWith('offer.sent', GUEST, expect.any(Object), { dedupeKey: expect.stringMatching(/^offer\.sent:/) });
  });

  it('works from host_review', async () => {
    const { service, booking } = setup({ booking: { status: 'host_review' } });
    await service.createOffer(HOST, BID, {});
    expect(booking.status).toBe('offered');
  });

  it('ignores any client-sent total: unknown fields cannot change the price', async () => {
    const { service } = setup();
    const r = await service.createOffer(HOST, BID, { total: 1, due_at_move_in: 1, price_snapshot: { hostAdjustedTotal: 1 } } as never);
    expect(r.offer.total).toBe(computed);
  });

  it('rejects an adjusted total outside +/-25% (tampered) and never writes', async () => {
    const { service, offers, booking } = setup();
    await expect(service.createOffer(HOST, BID, { adjustedTotal: computed * 2 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createOffer(HOST, BID, { adjustedTotal: 1 })).rejects.toBeInstanceOf(BadRequestException);
    expect(offers).toHaveLength(0);
    expect(booking.status).toBe('requested');
  });

  it('accepts an adjusted total inside the band; bounds are configurable', async () => {
    const a = setup();
    expect((await a.service.createOffer(HOST, BID, { adjustedTotal: 3750 })).offer.total).toBe(3750);
    const b = setup({ env: { OFFER_PRICE_ADJUST_MAX_PCT: 5 } });
    await expect(b.service.createOffer(HOST, BID, { adjustedTotal: 3750 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('admin override can exceed the band', async () => {
    const { service } = setup();
    const r = await service.createOffer('admin1', BID, { adjustedTotal: 9000 }, undefined, true);
    expect(r.offer.total).toBe(9000);
  });

  it('only the booking host (not the guest) can offer', async () => {
    const { service } = setup();
    await expect(service.createOffer(GUEST, BID, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses ineligible listings (booking_eligible false) and bad statuses', async () => {
    const a = setup({ listing: { ...listing, booking_eligible: false } });
    await expect(a.service.createOffer(HOST, BID, {})).rejects.toBeInstanceOf(ForbiddenException);
    const b = setup({ booking: { status: 'confirmed' } });
    await expect(b.service.createOffer(HOST, BID, {})).rejects.toBeInstanceOf(ConflictException);
  });

  it('409s when the dates are taken by a blocking booking', async () => {
    const { service, offers } = setup({ overlap: true });
    await expect(service.createOffer(HOST, BID, {})).rejects.toBeInstanceOf(ConflictException);
    expect(offers).toHaveLength(0);
  });

  it('is idempotent: same Idempotency-Key or identical payload replays the same offer', async () => {
    const { service, offers } = setup();
    const first = await service.createOffer(HOST, BID, { conditions: 'x' }, 'k1');
    const byKey = await service.createOffer(HOST, BID, { conditions: 'changed' }, 'k1');
    expect(byKey.replayed).toBe(true);
    expect(byKey.offer.id).toBe(first.offer.id);
    const byPayload = await service.createOffer(HOST, BID, { conditions: 'x' });
    expect(byPayload.replayed).toBe(true);
    expect(offers).toHaveLength(1);
  });

  it('a revised offer supersedes the pending one and bumps the version (booking stays offered)', async () => {
    const { service, offers, booking, events } = setup();
    // test double allows only one pending row: emulate the DB by superseding before save
    await service.createOffer(HOST, BID, { adjustedTotal: 3000 });
    const res = await service.createOffer(HOST, BID, { adjustedTotal: 3300 });
    expect(booking.status).toBe('offered');
    expect(offers[0].state).toBe('superseded');
    expect(res.offer.version).toBe(2);
    expect(events.filter((e) => e.from_status === 'offered' && e.to_status === 'offered')).toHaveLength(1);
  });

  it('concurrent offers: losing the unique-pending race is a 409, not a 500', async () => {
    const { service, offerRepo } = setup();
    offerRepo.save.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(service.createOffer(HOST, BID, {})).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('BookingOffersService.acceptOffer', () => {
  const pending = (over: any = {}) => ({
    id: 'o1',
    booking_id: BID,
    version: 1,
    state: 'pending',
    expires_at: new Date(Date.now() + 5 * HOUR),
    price_snapshot: { ...computePriceSnapshot({ dailyBaseRate: 1000, weeklyDiscountPct: 15, monthlyDiscountPct: 40 }, 3, 2), },
    ...over,
  });

  it('offered -> awaiting_payment, sets pay_by_at and charges the SNAPSHOT amount', async () => {
    const snap = { ...pending().price_snapshot, subtotal: 3300, hostAdjustedTotal: 3300, adjustmentPct: 10 };
    const { service, booking, notifications, manager } = setup({ booking: { status: 'offered' }, offers: [pending({ price_snapshot: snap })] });
    const r = await service.acceptOffer(GUEST, BID);
    expect(r.status).toBe('awaiting_payment');
    expect(booking.status).toBe('awaiting_payment');
    expect(booking.due_at_move_in).toBe(3300);
    expect(booking.pay_by_at.getTime()).toBeGreaterThan(Date.now());
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('advisory'), ['l1']);
    expect(notifications.notify).toHaveBeenCalledWith('offer.accepted', HOST, expect.any(Object), { dedupeKey: 'offer.accepted:o1' });
  });

  it('double-accept race: the second caller replays or conflicts, never double-transitions', async () => {
    const { service, events } = setup({ booking: { status: 'offered' }, offers: [pending()] });
    const [a, b] = await Promise.allSettled([service.acceptOffer(GUEST, BID), service.acceptOffer(GUEST, BID)]);
    expect(a.status).toBe('fulfilled');
    expect(b.status === 'fulfilled' ? (b.value as any).replayed : true).toBe(true);
    expect(events.filter((e) => e.to_status === 'awaiting_payment')).toHaveLength(1);
  });

  it('CAS loss on the offer row (another accept won) is a 409 and rolls back the booking move', async () => {
    const { service, manager, booking } = setup({ booking: { status: 'offered' }, offers: [pending()] });
    const real = manager.update.getMockImplementation()!;
    manager.update.mockImplementation(async (e: unknown, w: any, s: any) =>
      e === BookingOfferEntity && s.state === 'accepted' ? { affected: 0 } : real(e, w, s));
    await expect(service.acceptOffer(GUEST, BID)).rejects.toBeInstanceOf(ConflictException);
    expect(booking.status).toBe('offered');
  });

  it('an expired offer cannot be accepted: it expires the offer and the booking', async () => {
    const { service, booking, offers } = setup({ booking: { status: 'offered' }, offers: [pending({ expires_at: new Date(Date.now() - 1000) })] });
    await expect(service.acceptOffer(GUEST, BID)).rejects.toBeInstanceOf(ConflictException);
    expect(offers[0].state).toBe('expired');
    expect(booking.status).toBe('expired');
  });

  it('re-checks availability at accept time', async () => {
    const { service, booking } = setup({ booking: { status: 'offered' }, offers: [pending()], overlap: true });
    await expect(service.acceptOffer(GUEST, BID)).rejects.toBeInstanceOf(ConflictException);
    expect(booking.status).toBe('offered');
  });

  it('refuses a corrupted/tampered snapshot', async () => {
    const bad = pending();
    bad.price_snapshot.hostAdjustedTotal -= 500;
    const { service } = setup({ booking: { status: 'offered' }, offers: [bad] });
    await expect(service.acceptOffer(GUEST, BID)).rejects.toBeInstanceOf(ConflictException);
  });

  it('only the guest can accept', async () => {
    const { service } = setup({ booking: { status: 'offered' }, offers: [pending()] });
    await expect(service.acceptOffer(HOST, BID)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('decline / withdraw', () => {
  const pend = { id: 'o1', booking_id: BID, version: 1, state: 'pending', expires_at: new Date(Date.now() + HOUR) };
  it('guest decline cancels the booking, host withdraw declines it; both idempotent', async () => {
    const g = setup({ booking: { status: 'offered' }, offers: [{ ...pend }] });
    expect((await g.service.declineOffer(GUEST, BID)).status).toBe('cancelled');
    expect((await g.service.declineOffer(GUEST, BID)).replayed).toBe(true);
    const h = setup({ booking: { status: 'offered' }, offers: [{ ...pend }] });
    expect((await h.service.withdrawOffer(HOST, BID)).status).toBe('declined');
    expect(h.offers[0].state).toBe('withdrawn');
  });
});

describe('expiry sweep', () => {
  it('expires overdue pending offers + booking, notifies both with dedupe keys; idempotent', async () => {
    const o = { id: 'o1', booking_id: BID, version: 1, state: 'pending', expires_at: new Date(Date.now() - 1000) };
    const s = setup({ booking: { status: 'offered' }, offers: [o] });
    s.qb.getMany.mockResolvedValueOnce([o]).mockResolvedValue([]);
    const first = await s.service.expireOffers();
    expect(first.expired).toBe(1);
    expect(s.booking.status).toBe('expired');
    expect(s.notifications.notify).toHaveBeenCalledWith('offer.expired', GUEST, expect.any(Object), { dedupeKey: 'offer.expired:o1:guest' });
    expect(s.notifications.notify).toHaveBeenCalledWith('offer.expired', HOST, expect.any(Object), { dedupeKey: 'offer.expired:o1:host' });
    s.qb.getMany.mockResolvedValueOnce([o]).mockResolvedValue([]); // stale read of the same row
    expect((await s.service.expireOffers()).expired).toBe(0); // CAS misses: already expired
  });

  it('sends the one-shot expiring reminder', async () => {
    const o = { id: 'o2', booking_id: BID, version: 1, state: 'pending', expires_at: new Date(Date.now() + HOUR) };
    const s = setup({ booking: { status: 'offered' }, offers: [o] });
    s.qb.getMany.mockResolvedValueOnce([]).mockResolvedValueOnce([o]);
    const r = await s.service.expireOffers();
    expect(r.reminded).toBe(1);
    expect(s.notifications.notify).toHaveBeenCalledWith('offer.expiring', GUEST, expect.any(Object), { dedupeKey: 'offer.expiring:o2' });
  });
});

describe('scheduler + instant booking', () => {
  it('enqueues one idempotent automation job per minute, falls back inline without a queue', async () => {
    const offers = { expireOffers: jest.fn().mockResolvedValue({}) };
    const queues = { enqueue: jest.fn().mockResolvedValue({}) };
    const now = new Date('2027-01-01T00:00:30Z');
    expect(await new BookingOffersScheduler(offers as never, queues as never).run(now)).toBe('queued');
    expect(queues.enqueue).toHaveBeenCalledWith('automation', 'offers.expire-sweep', {}, { idempotencyKey: expect.stringMatching(/^offers\.expire-sweep-\d+$/) });
    queues.enqueue.mockRejectedValue(new Error('REDIS_URL is not set'));
    expect(await new BookingOffersScheduler(offers as never, queues as never).run(now)).toBe('inline');
    expect(await new BookingOffersScheduler(offers as never).run(now)).toBe('inline');
    expect(offers.expireOffers).toHaveBeenCalledTimes(2);
  });

  it('instant booking stays disabled: no transition skips the host offer', () => {
    expect(INSTANT_BOOKING_ENABLED).toBe(false);
    const { canTransition } = jest.requireActual('./booking-transitions');
    expect(canTransition('requested', 'awaiting_payment')).toBe(false);
  });
});
