import { ForbiddenException } from '@nestjs/common';
import { BookingsService } from './bookings.service';

const BOOKING = 'b1';
const GUEST = 'g1';
const HOST = 'h1';
const HOUR = 60 * 60 * 1000;

function makeService(opts: { cases?: Record<string, unknown>[]; lastEvent?: Record<string, unknown> | null; caseStatus?: string } = {}) {
  const bookingsRepo = { findOne: jest.fn().mockResolvedValue({ guest_id: GUEST, host_id: HOST, listing_id: 'l1' }) };
  const disputeCasesRepo = {
    findOne: jest.fn().mockResolvedValue({
      id: 'c1',
      booking_id: BOOKING,
      case_status: opts.caseStatus ?? 'open',
      negotiation_rounds: 0,
      created_at: new Date(),
      updated_at: new Date(),
    }),
    find: jest.fn().mockResolvedValue(opts.cases ?? []),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const disputeEventsRepo = {
    findOne: jest.fn().mockResolvedValue(opts.lastEvent ?? { event_type: 'claim_raised', actor_role: 'guest' }),
    find: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockResolvedValue(undefined),
  };
  const stub = { findOne: jest.fn().mockResolvedValue(null) };
  const payments = { getForBooking: jest.fn().mockResolvedValue({ amount: 10000 }) };
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
  return { service, disputeCasesRepo, disputeEventsRepo };
}

describe('BookingsService dispute negotiation', () => {
  it('rejects the guest making an offer before the host has offered', async () => {
    const { service, disputeEventsRepo } = makeService();
    await expect(service.makeDisputeOffer(GUEST, BOOKING, 5000, undefined)).rejects.toBeInstanceOf(ForbiddenException);
    expect(disputeEventsRepo.insert).not.toHaveBeenCalled();
  });

  it('lets the host make the first offer', async () => {
    const { service, disputeEventsRepo } = makeService();
    await service.makeDisputeOffer(HOST, BOOKING, 6000, undefined);
    expect(disputeEventsRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ actor_role: 'host', event_type: 'host_offer', offer_amount: 6000 }),
    );
  });

  it('still lets the guest counter a standing host offer', async () => {
    const { service, disputeEventsRepo } = makeService({
      caseStatus: 'negotiating',
      lastEvent: { event_type: 'host_offer', actor_role: 'host' },
    });
    await service.makeDisputeOffer(GUEST, BOOKING, 8000, undefined);
    expect(disputeEventsRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'guest_counter' }));
  });
});

describe('BookingsService.getDisputeCase response deadline', () => {
  it('gives an open case a deadline 48h after it was raised', async () => {
    const { service } = makeService();
    const res = await service.getDisputeCase(GUEST, BOOKING);
    const created = (await (service as never as { disputeCasesRepo: { findOne: () => Promise<{ created_at: Date }> } }).disputeCasesRepo.findOne()).created_at;
    expect(new Date(res.responseDeadline as string).getTime() - created.getTime()).toBe(48 * HOUR);
  });

  it('has no deadline once the case is with admin', async () => {
    const { service } = makeService({ caseStatus: 'escalated' });
    await expect(service.getDisputeCase(HOST, BOOKING)).resolves.toMatchObject({ responseDeadline: null });
  });

  it('lets an admin (not a party) load the timeline', async () => {
    const { service } = makeService();
    await expect(service.getDisputeCaseForAdmin(BOOKING)).resolves.toMatchObject({ viewerRole: 'admin' });
  });
});

describe('BookingsService.escalateStaleNegotiations', () => {
  const old = new Date(Date.now() - 49 * HOUR);
  const fresh = new Date(Date.now() - 1 * HOUR);

  it('escalates an open case the host never answered within 48h of it being raised', async () => {
    const { service, disputeCasesRepo, disputeEventsRepo } = makeService({
      cases: [{ id: 'c1', case_status: 'open', created_at: old, updated_at: fresh }],
    });
    await expect(service.escalateStaleNegotiations()).resolves.toBe(1);
    expect(disputeCasesRepo.update).toHaveBeenCalledWith({ id: 'c1' }, expect.objectContaining({ case_status: 'escalated' }));
    expect(disputeEventsRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ actor_role: 'system', event_type: 'escalated', message: expect.stringMatching(/host did not respond/) }),
    );
  });

  it('leaves a recent open case alone', async () => {
    const { service, disputeCasesRepo } = makeService({
      cases: [{ id: 'c1', case_status: 'open', created_at: fresh, updated_at: old }],
    });
    await expect(service.escalateStaleNegotiations()).resolves.toBe(0);
    expect(disputeCasesRepo.update).not.toHaveBeenCalled();
  });

  it('escalates a negotiating case idle for 48h, judged on updated_at', async () => {
    const { service } = makeService({
      cases: [{ id: 'c2', case_status: 'negotiating', created_at: old, updated_at: old }],
    });
    await expect(service.escalateStaleNegotiations()).resolves.toBe(1);
  });

  it('leaves a negotiating case with recent activity alone even if it was raised long ago', async () => {
    const { service } = makeService({
      cases: [{ id: 'c2', case_status: 'negotiating', created_at: old, updated_at: fresh }],
    });
    await expect(service.escalateStaleNegotiations()).resolves.toBe(0);
  });
});
