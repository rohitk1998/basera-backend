import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BookingEntity, DisputeCaseEntity, DisputeEventEntity } from '../entities';
import { BookingsService } from './bookings.service';
import { fakeDataSource } from './bookings.test-utils';

const GUEST = 'g1';
const HOST = 'h1';

function make(listing: Record<string, unknown> | null = {}) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'andWhere']) qb[m] = jest.fn().mockReturnValue(qb);
  qb.getOne = jest.fn().mockResolvedValue(null);
  const bookingsRepo: Record<string, jest.Mock> = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'new1' }] }),
  };
  const repos = new Map<unknown, any>([
    [BookingEntity, bookingsRepo],
    [DisputeCaseEntity, { update: jest.fn(), findOne: jest.fn() }],
    [DisputeEventEntity, { insert: jest.fn() }],
  ]);
  const ds = fakeDataSource(repos);
  const listingsRepo = {
    findOne: jest.fn().mockResolvedValue(
      listing === null
        ? null
        : { id: 'l1', status: 'live', booking_eligible: true, is_discovered: false, host_id: HOST, draft_data: { property_details: { title: 'Loft', dailyBaseRate: 1000 } }, ...listing },
    ),
  };
  const profilesRepo = { findOne: jest.fn().mockResolvedValue({ id: GUEST, full_name: 'G', phone: '9876543210', email_verified_at: new Date() }) };
  const notifications = { notify: jest.fn() };
  const config = { get: jest.fn((k: string) => (k === 'PLATFORM_COMMISSION_PERCENTAGE' ? 6 : undefined)) };
  const stub = { findOne: jest.fn().mockResolvedValue(null), insert: jest.fn() };
  const service = new BookingsService(
    bookingsRepo as never,
    ds.events as never,
    listingsRepo as never,
    profilesRepo as never,
    stub as never,
    repos.get(DisputeCaseEntity) as never,
    repos.get(DisputeEventEntity) as never,
    notifications as never,
    {} as never,
    {} as never,
    ds.dataSource as never,
    config as never,
    {} as never,
    { assertDatesFree: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { service, bookingsRepo, notifications };
}

const dto = { listingId: 'l1', moveIn: '2027-03-01', moveOut: '2027-03-11', days: 10, adults: 2, children: 0, infants: 0, pets: 0, paymentMethod: 'upi', role: 'guest' } as never;

describe('BookingsService.create with source "inquiry"', () => {
  it('skips only the ID disclaimer check and stores it as NULL', async () => {
    const { service, bookingsRepo, notifications } = make();
    const res: any = await service.create(GUEST, dto, 'inquiry:q1', { source: 'inquiry' });
    expect(res).toMatchObject({ id: 'new1', status: 'requested' });
    const row = bookingsRepo.insert.mock.calls[0][0];
    expect(row.id_disclaimer_accepted_at ?? null).toBeNull();
    expect(row.id_disclaimer_version ?? null).toBeNull();
    expect(row.idempotency_key).toBe('inquiry:q1');
    expect(row.status).toBe('requested');
    // the owner still gets the normal booking.requested notification
    expect(notifications.notify).toHaveBeenCalledWith('booking.requested', HOST, expect.anything());
  });

  it('without opts the disclaimer is still required', async () => {
    const { service, bookingsRepo } = make();
    await expect(service.create(GUEST, dto, 'k')).rejects.toBeInstanceOf(BadRequestException);
    expect(bookingsRepo.insert).not.toHaveBeenCalled();
  });

  it('an unrelated source value does not skip the disclaimer', async () => {
    const { service } = make();
    await expect(service.create(GUEST, dto, 'k', { source: 'other' } as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('with a disclaimer accepted the normal path still stores it', async () => {
    const { service, bookingsRepo } = make();
    await service.create(GUEST, { ...(dto as object), idDisclaimerAccepted: true } as never, 'k');
    expect(bookingsRepo.insert.mock.calls[0][0].id_disclaimer_accepted_at).toBeInstanceOf(Date);
  });

  it('still rejects a discovered listing', async () => {
    const { service, bookingsRepo } = make({ is_discovered: true });
    await expect(service.create(GUEST, dto, 'inquiry:q1', { source: 'inquiry' })).rejects.toBeInstanceOf(NotFoundException);
    expect(bookingsRepo.insert).not.toHaveBeenCalled();
  });

  it('still rejects a listing that is not live and one that is not booking eligible', async () => {
    await expect(make({ status: 'draft' }).service.create(GUEST, dto, 'k', { source: 'inquiry' })).rejects.toBeInstanceOf(BadRequestException);
    const b = make({ booking_eligible: false });
    await expect(b.service.create(GUEST, dto, 'k', { source: 'inquiry' })).rejects.toBeDefined();
    expect(b.bookingsRepo.insert).not.toHaveBeenCalled();
  });

  it('the same key replays the same booking and inserts nothing', async () => {
    const { service, bookingsRepo } = make();
    bookingsRepo.findOne.mockResolvedValueOnce({ id: 'old1', status: 'requested', reference: 'RB-AAAAAA' });
    const res = await service.create(GUEST, dto, 'inquiry:q1', { source: 'inquiry' });
    expect(res).toMatchObject({ id: 'old1', reference: 'RB-AAAAAA', replayed: true });
    expect(bookingsRepo.insert).not.toHaveBeenCalled();
  });

  it('carries machine-readable codes on date errors', async () => {
    const past = make();
    const e1: any = await past.service.create(GUEST, { ...(dto as object), moveIn: '2020-01-01', moveOut: '2020-01-03' } as never, 'k', { source: 'inquiry' }).catch((e) => e);
    expect(e1.getResponse().code).toBe('DATES_PAST');
    const busy = make();
    (busy.bookingsRepo.createQueryBuilder() as any).getOne.mockResolvedValue({ id: 'other' });
    // overlap lookup inside the tx uses the same query builder mock for any booking
    const e2: any = await busy.service.create(GUEST, dto, 'k', { source: 'inquiry' }).catch((e) => e);
    expect(['DATES_BUSY', 'SELF_OVERLAP']).toContain(e2.getResponse().code);
    const open = make();
    open.bookingsRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'x' });
    const e3: any = await open.service.create(GUEST, dto, 'k2', { source: 'inquiry' }).catch((e) => e);
    expect(e3.getResponse().code).toBe('OPEN_REQUEST');
  });
});
