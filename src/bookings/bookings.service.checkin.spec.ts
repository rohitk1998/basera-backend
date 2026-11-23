import { BadRequestException, HttpException } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { BookingEntity } from '../entities';
import { fakeDataSource } from './bookings.test-utils';

/** In-memory stand-in for the check_in_lockouts table, keyed by booking id. */
export function fakeLockoutDb(state = new Map<string, { count: number; lockedUntil: Date | null }>()) {
  const query = jest.fn(async (sql: string, params: any[]) => {
    const [id] = params;
    if (sql.startsWith('SELECT')) {
      const row = state.get(id);
      return row ? [{ locked_until: row.lockedUntil }] : [];
    }
    if (sql.startsWith('DELETE')) {
      state.delete(id);
      return [];
    }
    const [, now, max, lockedUntil] = params as [string, Date, number, Date];
    const prev = state.get(id);
    const count = prev && !(prev.lockedUntil && prev.lockedUntil <= now) ? prev.count + 1 : 1;
    state.set(id, { count, lockedUntil: count >= max ? lockedUntil : null });
    return [];
  });
  return { query, state };
}

const ID = 'b1';
const GUEST = 'g1';

function makeService(booking: Record<string, unknown>, lockouts = fakeLockoutDb()) {
  const bookingsRepo = {
    findOne: jest.fn().mockResolvedValue({
      status: 'confirmed',
      guest_id: GUEST,
      host_id: 'h1',
      listing_id: 'l1',
      checkin_code: '1234',
      ...booking,
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const payments = { getForBooking: jest.fn().mockResolvedValue({ status: 'held' }) };
  const stub = { findOne: jest.fn().mockResolvedValue(null), insert: jest.fn() };
  const notifications = { notify: jest.fn() };
  const { dataSource } = fakeDataSource(new Map([[BookingEntity, bookingsRepo as never]]), lockouts.query);
  const service = new BookingsService(
    bookingsRepo as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    notifications as never,
    payments as never,
    {} as never,
    dataSource as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, bookingsRepo, lockouts };
}

describe('BookingsService.checkin date window', () => {
  afterEach(() => jest.useRealTimers());

  function at(iso: string) {
    jest.useFakeTimers().setSystemTime(new Date(iso));
  }

  it('rejects before move-in with the date, without counting toward the lockout', async () => {
    at('2026-10-14T06:00:00Z');
    const { service } = makeService({ move_in: '2026-11-01', move_out: '2026-11-10' });
    for (let i = 0; i < 8; i++) {
      await expect(service.checkin(GUEST, ID, '0000')).rejects.toThrow('Check-in opens on 1 Nov 2026.');
    }
    at('2026-11-01T06:00:00Z');
    await expect(service.checkin(GUEST, ID, '0000')).rejects.toThrow('That check-in code is incorrect.');
  });

  it('allows check-in on move-in day (India date)', async () => {
    at('2026-10-31T19:00:00Z');
    const { service } = makeService({ move_in: '2026-11-01', move_out: '2026-11-10' });
    await expect(service.checkin(GUEST, ID, '1234')).resolves.toMatchObject({ status: 'checked_in' });
  });

  it('rejects after move-out', async () => {
    at('2026-11-12T06:00:00Z');
    const { service } = makeService({ move_in: '2026-11-01', move_out: '2026-11-10' });
    await expect(service.checkin(GUEST, ID, '1234')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('locks out after 5 wrong codes with retry-after seconds', async () => {
    at('2026-11-02T06:00:00Z');
    const { service } = makeService({ move_in: '2026-11-01', move_out: '2026-11-10' });
    for (let i = 0; i < 5; i++) {
      await expect(service.checkin(GUEST, ID, '0000')).rejects.toBeInstanceOf(BadRequestException);
    }
    const err = (await service.checkin(GUEST, ID, '0000').catch((e: unknown) => e)) as HttpException;
    expect(err.getStatus()).toBe(429);
    expect(err.getResponse()).toMatchObject({
      message: 'Too many attempts. Try again in 15 minutes.',
      retryAfterSeconds: 900,
    });
  });

  it('persists the lockout in the DB so another instance also refuses', async () => {
    at('2026-11-02T06:00:00Z');
    const shared = fakeLockoutDb();
    const a = makeService({ move_in: '2026-11-01', move_out: '2026-11-10' }, shared);
    for (let i = 0; i < 5; i++) await a.service.checkin(GUEST, ID, '0000').catch(() => undefined);
    expect(shared.state.get(ID)?.count).toBe(5);
    const b = makeService({ move_in: '2026-11-01', move_out: '2026-11-10' }, shared); // fresh instance, no memory
    const err = (await b.service.checkin(GUEST, ID, '1234').catch((e: unknown) => e)) as HttpException;
    expect(err.getStatus()).toBe(429);
  });

  it('clears the counter after a correct code', async () => {
    at('2026-11-02T06:00:00Z');
    const { service, lockouts } = makeService({ move_in: '2026-11-01', move_out: '2026-11-10' });
    await service.checkin(GUEST, ID, '0000').catch(() => undefined);
    expect(lockouts.state.get(ID)?.count).toBe(1);
    await service.checkin(GUEST, ID, '1234');
    expect(lockouts.state.has(ID)).toBe(false);
  });

  it('lets the guest retry once the lockout has expired', async () => {
    at('2026-11-02T06:00:00Z');
    const shared = fakeLockoutDb();
    const { service } = makeService({ move_in: '2026-11-01', move_out: '2026-11-10' }, shared);
    for (let i = 0; i < 5; i++) await service.checkin(GUEST, ID, '0000').catch(() => undefined);
    at('2026-11-02T06:16:00Z');
    await expect(service.checkin(GUEST, ID, '1234')).resolves.toMatchObject({ status: 'checked_in' });
  });
});
