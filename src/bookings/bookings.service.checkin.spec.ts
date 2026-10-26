import { BadRequestException, HttpException } from '@nestjs/common';
import { BookingsService } from './bookings.service';

const ID = 'b1';
const GUEST = 'g1';

function makeService(booking: Record<string, unknown>) {
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
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, bookingsRepo };
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
});
