import { ForbiddenException } from '@nestjs/common';
import {
  SocialAccessService,
  SOCIAL_ELIGIBLE_BOOKING_STATUSES,
  STORY_AUTHOR_BOOKING_STATUSES,
  applyInProgressWindow,
  indiaToday,
  isStayInProgress,
} from './social-access.service';

const LISTING = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';

function chain(result: Record<string, unknown>) {
  const qb: Record<string, jest.Mock> = {};
  for (const name of ['where', 'andWhere', 'select'])
    qb[name] = jest.fn().mockReturnValue(qb);
  Object.assign(qb, result);
  return qb;
}

function makeService(opts: {
  count?: number;
  guestIds?: string[];
  blocks?: { blocker_id: string; blocked_id: string }[];
}) {
  const bookingsQb = chain({
    getCount: jest.fn().mockResolvedValue(opts.count ?? 0),
    getRawMany: jest
      .fn()
      .mockResolvedValue(
        (opts.guestIds ?? []).map((guest_id) => ({ guest_id })),
      ),
  });
  const blocksQb = chain({
    getMany: jest.fn().mockResolvedValue(opts.blocks ?? []),
  });
  const service = new SocialAccessService(
    { createQueryBuilder: jest.fn().mockReturnValue(bookingsQb) } as never,
    { createQueryBuilder: jest.fn().mockReturnValue(blocksQb) } as never,
  );
  return { service, bookingsQb };
}

describe('SocialAccessService', () => {
  it('treats only confirmed and checked_in as in-progress statuses', () => {
    expect([...SOCIAL_ELIGIBLE_BOOKING_STATUSES]).toEqual([
      'confirmed',
      'checked_in',
    ]);
  });

  it('lets story authors be confirmed, checked_in, checked_out or completed', () => {
    expect([...STORY_AUTHOR_BOOKING_STATUSES]).toEqual([
      'confirmed',
      'checked_in',
      'checked_out',
      'completed',
    ]);
  });

  describe('in-progress window', () => {
    const today = '2026-11-10';
    it('arriving tomorrow is not eligible', () => {
      expect(isStayInProgress('2026-11-11', '2026-11-18', today)).toBe(false);
    });
    it('checked out yesterday is not eligible', () => {
      expect(isStayInProgress('2026-11-03', '2026-11-09', today)).toBe(false);
    });
    it('today is eligible (move-in day)', () => {
      expect(isStayInProgress('2026-11-10', '2026-11-17', today)).toBe(true);
    });
    it('the last day is eligible', () => {
      expect(isStayInProgress('2026-11-03', '2026-11-10', today)).toBe(true);
    });

    it('uses the India date, not the UTC date', () => {
      // 20:00 UTC on the 9th is 01:30 IST on the 10th.
      expect(indiaToday(new Date('2026-11-09T20:00:00Z'))).toBe('2026-11-10');
      expect(indiaToday(new Date('2026-11-10T18:00:00Z'))).toBe('2026-11-10');
    });

    it('applyInProgressWindow bounds both ends inclusively with the India date', () => {
      const { bookingsQb } = makeService({});
      applyInProgressWindow(
        bookingsQb as never,
        'b',
        new Date('2026-11-09T20:00:00Z'),
      );
      expect(bookingsQb.andWhere).toHaveBeenCalledWith(
        "b.move_in <= '2026-11-10'",
      );
      expect(bookingsQb.andWhere).toHaveBeenCalledWith(
        "COALESCE(b.actual_move_out, b.move_out) >= '2026-11-10'",
      );
    });
  });

  it('assertGuestOfListing passes with an eligible booking', async () => {
    const { service, bookingsQb } = makeService({ count: 1 });
    await expect(
      service.assertGuestOfListing(ME, LISTING),
    ).resolves.toBeUndefined();
    expect(bookingsQb.andWhere).toHaveBeenCalledWith(
      'b.status IN (:...statuses)',
      {
        statuses: SOCIAL_ELIGIBLE_BOOKING_STATUSES,
      },
    );
  });

  it('assertGuestOfListing applies the in-progress window', async () => {
    const { service, bookingsQb } = makeService({ count: 1 });
    await service.assertGuestOfListing(ME, LISTING);
    expect(bookingsQb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('b.move_in <= '),
    );
  });

  it('assertStoryAuthorOfListing has no date window and allows completed stays', async () => {
    const { service, bookingsQb } = makeService({ count: 1 });
    await expect(
      service.assertStoryAuthorOfListing(ME, LISTING),
    ).resolves.toBeUndefined();
    expect(bookingsQb.andWhere).toHaveBeenCalledTimes(1);
    expect(bookingsQb.andWhere).toHaveBeenCalledWith(
      'b.status IN (:...statuses)',
      { statuses: STORY_AUTHOR_BOOKING_STATUSES },
    );
  });

  it('assertStoryAuthorOfListing throws without a booking', async () => {
    const { service } = makeService({ count: 0 });
    await expect(
      service.assertStoryAuthorOfListing(ME, LISTING),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('assertGuestOfListing throws without an eligible booking', async () => {
    const { service } = makeService({ count: 0 });
    await expect(
      service.assertGuestOfListing(ME, LISTING),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('assertGuestOfListing throws for a malformed listing id without querying', async () => {
    const { service, bookingsQb } = makeService({ count: 1 });
    await expect(
      service.assertGuestOfListing(ME, 'nope'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(bookingsQb.getCount).not.toHaveBeenCalled();
  });

  it('listEligibleGuestIds drops users blocked in either direction', async () => {
    const { service } = makeService({
      guestIds: ['a', 'b', 'c'],
      blocks: [
        { blocker_id: ME, blocked_id: 'a' },
        { blocker_id: 'b', blocked_id: ME },
      ],
    });
    await expect(service.listEligibleGuestIds(LISTING, ME)).resolves.toEqual([
      'c',
    ]);
  });

  it('listEligibleGuestIds returns empty for a malformed listing id', async () => {
    const { service } = makeService({ guestIds: ['a'] });
    await expect(service.listEligibleGuestIds('nope', ME)).resolves.toEqual([]);
  });
});
