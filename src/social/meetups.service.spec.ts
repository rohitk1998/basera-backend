import { BadRequestException, ConflictException } from '@nestjs/common';
import { MeetupsService } from './meetups.service';

const HOUR = 3600_000;

function makeService() {
  const access = {
    assertGuestOfListing: jest.fn().mockResolvedValue(undefined),
  };
  const safety = { blockedIdsFor: jest.fn().mockResolvedValue([]) };
  const manager = {
    findOne: jest.fn(),
    exists: jest.fn().mockResolvedValue(false),
    count: jest.fn().mockResolvedValue(0),
    insert: jest.fn().mockResolvedValue(undefined),
  };
  const dataSource = {
    transaction: jest.fn((fn: (m: typeof manager) => unknown) => fn(manager)),
  };
  const meetups = {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  };
  const service = new MeetupsService(
    meetups as never,
    {} as never,
    {} as never,
    {} as never,
    dataSource as never,
    access as never,
    safety as never,
  );
  return { service, manager, meetups, access };
}

const base = { title: 't', description: 'd', placeText: 'cafe', town: 'Bir' };

describe('MeetupsService.create', () => {
  it('rejects a start time in the past', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', {
        ...base,
        startsAt: new Date(Date.now() - HOUR).toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a start time more than 90 days ahead', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', {
        ...base,
        startsAt: new Date(Date.now() + 91 * 24 * HOUR).toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects capacity of 1', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', {
        ...base,
        capacity: 1,
        startsAt: new Date(Date.now() + HOUR).toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('MeetupsService.join', () => {
  it('refuses when the meetup is full', async () => {
    const { service, manager, meetups } = makeService();
    const row = {
      id: 'm1',
      host_user_id: 'h',
      listing_id: null,
      status: 'open',
      capacity: 2,
      starts_at: new Date(Date.now() + HOUR),
    };
    meetups.findOne.mockResolvedValue(row);
    manager.findOne.mockResolvedValue(row);
    manager.count.mockResolvedValue(2);
    await expect(service.join('u1', 'm1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('refuses a cancelled meetup', async () => {
    const { service, manager, meetups } = makeService();
    const row = {
      id: 'm1',
      host_user_id: 'h',
      listing_id: null,
      status: 'cancelled',
      capacity: null,
      starts_at: new Date(Date.now() + HOUR),
    };
    meetups.findOne.mockResolvedValue(row);
    manager.findOne.mockResolvedValue(row);
    await expect(service.join('u1', 'm1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('MeetupsService.leave', () => {
  it('stops the host from leaving', async () => {
    const { service, meetups } = makeService();
    meetups.findOne.mockResolvedValue({ id: 'm1', host_user_id: 'u1' });
    await expect(service.leave('u1', 'm1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
