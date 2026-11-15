import { ForbiddenException } from '@nestjs/common';
import { GuestProfileService } from './guest-profile.service';

const LISTING = '11111111-1111-4111-8111-111111111111';

function qb(result: Record<string, unknown>) {
  const q: Record<string, jest.Mock> = {};
  for (const name of [
    'where',
    'andWhere',
    'orderBy',
    'limit',
    'select',
    'setParameters',
  ]) {
    q[name] = jest.fn().mockReturnValue(q);
  }
  Object.assign(q, result);
  return q;
}

function makeService(
  access: Record<string, jest.Mock>,
  profiles: unknown[] = [],
  users: unknown[] = [],
) {
  const profilesRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn().mockReturnValue(
      qb({
        getMany: jest.fn().mockResolvedValue(profiles),
        getCount: jest.fn().mockResolvedValue(3),
      }),
    ),
  };
  const usersRepo = {
    createQueryBuilder: jest
      .fn()
      .mockReturnValue(qb({ getMany: jest.fn().mockResolvedValue(users) })),
  };
  const service = new GuestProfileService(
    profilesRepo as never,
    usersRepo as never,
    {} as never,
    access as never,
  );
  return { service, profilesRepo };
}

describe('GuestProfileService', () => {
  it('defaults to a hidden profile', async () => {
    const { service } = makeService({});
    await expect(service.getProfile('u1')).resolves.toEqual({
      visible: false,
      headline: null,
      homeCountry: null,
      workStatus: null,
    });
  });

  it('upserts the profile and echoes it back', async () => {
    const { service, profilesRepo } = makeService({});
    const out = await service.updateProfile('u1', {
      visible: true,
      headline: 'Designer',
      homeCountry: undefined,
    });
    expect(profilesRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'u1',
        visible: true,
        headline: 'Designer',
        home_country: null,
      }),
      ['user_id'],
    );
    expect(out.visible).toBe(true);
  });

  it('summary returns 0 for a malformed listing id and a count otherwise', async () => {
    const { service } = makeService({});
    await expect(service.getListingSummary('nope')).resolves.toEqual({
      guestsHereCount: 0,
    });
    await expect(service.getListingSummary(LISTING)).resolves.toEqual({
      guestsHereCount: 3,
    });
  });

  it('guest list is refused for non-guests', async () => {
    const access = {
      assertGuestOfListing: jest
        .fn()
        .mockRejectedValue(new ForbiddenException()),
      listEligibleGuestIds: jest.fn(),
    };
    const { service } = makeService(access);
    await expect(service.listGuests('u1', LISTING)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(access.listEligibleGuestIds).not.toHaveBeenCalled();
  });

  it('guest cards expose first name and profile fields only', async () => {
    const access = {
      assertGuestOfListing: jest.fn().mockResolvedValue(undefined),
      listEligibleGuestIds: jest.fn().mockResolvedValue(['a']),
    };
    const { service } = makeService(
      access,
      [
        {
          user_id: 'a',
          headline: 'Dev',
          home_country: 'India',
          work_status: 'Remote',
        },
      ],
      [
        {
          id: 'a',
          full_name: 'Asha Verma',
          avatar_url: null,
          email: 'secret',
          phone: 'secret',
        },
      ],
    );
    const out = await service.listGuests('u1', LISTING);
    expect(out).toEqual({
      count: 1,
      guests: [
        {
          userId: 'a',
          firstName: 'Asha',
          avatarUrl: null,
          headline: 'Dev',
          homeCountry: 'India',
          workStatus: 'Remote',
        },
      ],
    });
    expect(JSON.stringify(out)).not.toContain('secret');
  });
});
