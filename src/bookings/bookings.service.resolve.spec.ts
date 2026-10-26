import { BookingsService } from './bookings.service';

const ID = 'b1';
const ADMIN = 'a1';

function makeService(disputeCase: Record<string, unknown> = {}) {
  const bookingsRepo = {
    findOne: jest.fn().mockResolvedValue({
      status: 'disputed',
      guest_id: 'g1',
      host_id: 'h1',
      listing_id: 'l1',
      move_in: '2026-10-14',
      move_out: '2026-10-21',
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const disputeCasesRepo = {
    findOne: jest.fn().mockResolvedValue({ id: 'c1', case_status: 'escalated', category: 'early_departure', leaving_on: '2026-10-16', ...disputeCase }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const disputeEventsRepo = { insert: jest.fn().mockResolvedValue(undefined) };
  const stub = { findOne: jest.fn().mockResolvedValue(null), insert: jest.fn() };
  const payments = { splitRelease: jest.fn().mockResolvedValue(undefined) };
  const notifications = { notify: jest.fn() };
  const service = new BookingsService(
    bookingsRepo as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    disputeCasesRepo as never,
    disputeEventsRepo as never,
    notifications as never,
    payments as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, bookingsRepo, disputeCasesRepo, payments };
}

describe('BookingsService.resolveDispute', () => {
  afterEach(() => jest.useRealTimers());

  it('splits the payment by the admin amount, records it, and completes the booking', async () => {
    const { service, payments, bookingsRepo, disputeCasesRepo } = makeService();
    await service.resolveDispute(ADMIN, ID, 7500, undefined);
    expect(payments.splitRelease).toHaveBeenCalledWith(ID, 7500);
    expect(disputeCasesRepo.update).toHaveBeenCalledWith({ id: 'c1' }, expect.objectContaining({ resolution_amount_to_guest: 7500 }));
    expect(bookingsRepo.update).toHaveBeenCalledWith(
      { id: ID, status: 'disputed' },
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('ends an early-departure stay on the guest leaving date', async () => {
    const { service, bookingsRepo } = makeService();
    await service.resolveDispute(ADMIN, ID, 7500, undefined);
    expect(bookingsRepo.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actual_move_out: '2026-10-16' }),
    );
  });

  it('falls back to today (IST) for a dispute with no leaving date, never past move-out', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-18T06:00:00Z'));
    const { service, bookingsRepo } = makeService({ category: 'cleanliness', leaving_on: null });
    await service.resolveDispute(ADMIN, ID, 0, undefined);
    expect(bookingsRepo.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actual_move_out: '2026-10-18' }));
  });

  it('clamps a late resolution to the original move-out', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-30T06:00:00Z'));
    const { service, bookingsRepo } = makeService({ category: 'damage_safety', leaving_on: null });
    await service.resolveDispute(ADMIN, ID, 0, undefined);
    expect(bookingsRepo.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actual_move_out: '2026-10-21' }));
  });
});
