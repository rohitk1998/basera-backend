import { ConflictException } from '@nestjs/common';
import { BookingsService } from './bookings.service';

const ID = 'b1';
const GUEST = 'g1';
const HOST = 'h1';

function makeService(booking: Record<string, unknown>, env: Record<string, string> = {}) {
  const bookingsRepo = {
    findOne: jest.fn().mockResolvedValue({
      status: 'checked_in',
      guest_id: GUEST,
      host_id: HOST,
      listing_id: 'l1',
      move_out: '2026-11-10',
      ...booking,
    }),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const payments = { release: jest.fn().mockResolvedValue(undefined) };
  const stub = { findOne: jest.fn().mockResolvedValue(null), insert: jest.fn() };
  const notifications = { notify: jest.fn() };
  const config = { get: jest.fn((k: string) => env[k]) };
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
    config as never,
  );
  return { service, bookingsRepo, notifications, payments };
}

describe('BookingsService.checkout', () => {
  afterEach(() => jest.useRealTimers());

  function at(iso: string) {
    jest.useFakeTimers().setSystemTime(new Date(iso));
  }

  it('rejects a guest checking out before move-out, pointing them to a dispute', async () => {
    at('2026-11-05T06:00:00Z');
    const { service, bookingsRepo } = makeService({});
    await expect(service.checkout(GUEST, ID)).rejects.toThrow(/report it instead/);
    await expect(service.checkout(GUEST, ID)).rejects.toBeInstanceOf(ConflictException);
    expect(bookingsRepo.update).not.toHaveBeenCalled();
  });

  it('judges move-out by the India calendar day', async () => {
    // 2026-11-09T19:00Z = 10 Nov 00:30 IST -> move-out day has begun in India.
    at('2026-11-09T19:00:00Z');
    const { service } = makeService({});
    await expect(service.checkout(GUEST, ID)).resolves.toMatchObject({ status: 'checked_out' });
  });

  it('lets the guest skip the early rule with CHECKOUT_DATE_BYPASS and notifies as early', async () => {
    at('2026-11-05T06:00:00Z');
    const { service, bookingsRepo, notifications } = makeService({}, { CHECKOUT_DATE_BYPASS: 'true' });
    await expect(service.checkout(GUEST, ID)).resolves.toMatchObject({ status: 'checked_out' });
    const patch = bookingsRepo.update.mock.calls[0][1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('escrow_release_time');
    expect(notifications.notify).toHaveBeenCalledWith('booking.checked_out_early', HOST, expect.anything());
  });

  it('lets the guest check out on move-out day with the normal notification', async () => {
    at('2026-11-10T06:00:00Z');
    const { service, notifications } = makeService({});
    await service.checkout(GUEST, ID);
    expect(notifications.notify).toHaveBeenCalledWith('booking.checked_out', HOST, expect.anything());
  });

  it('still blocks the host from checking the guest out before move-out', async () => {
    at('2026-11-05T06:00:00Z');
    const { service } = makeService({});
    await expect(service.checkout(HOST, ID)).rejects.toThrow('You cannot check out a guest before their move-out date.');
  });

  it('lets the host skip the date rules with CHECKOUT_DATE_BYPASS', async () => {
    at('2026-11-05T06:00:00Z');
    const { service } = makeService({}, { CHECKOUT_DATE_BYPASS: 'true' });
    await expect(service.checkout(HOST, ID)).resolves.toMatchObject({ status: 'checked_out' });
  });

  it('rejects a booking that is not checked in', async () => {
    at('2026-11-05T06:00:00Z');
    const { service } = makeService({ status: 'confirmed' });
    await expect(service.checkout(GUEST, ID)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a completed booking', async () => {
    at('2026-11-05T06:00:00Z');
    const { service, bookingsRepo } = makeService({ status: 'completed' });
    await expect(service.checkout(GUEST, ID)).rejects.toBeInstanceOf(ConflictException);
    expect(bookingsRepo.update).not.toHaveBeenCalled();
  });
});

describe('BookingsService.releaseHold after checkout', () => {
  it('releases a checked_out booking and records the checked_out -> completed event', async () => {
    const { service, bookingsRepo, payments } = makeService({ status: 'checked_out' });
    await service.releaseHold(ID);
    expect(payments.release).toHaveBeenCalledWith(ID);
    expect(bookingsRepo.update).toHaveBeenCalledWith({ id: ID, status: 'checked_out' }, expect.objectContaining({ status: 'completed' }));
  });

  it('ignores bookings that are neither checked_in nor checked_out', async () => {
    const { service, payments } = makeService({ status: 'disputed' });
    await service.releaseHold(ID);
    expect(payments.release).not.toHaveBeenCalled();
  });
});
