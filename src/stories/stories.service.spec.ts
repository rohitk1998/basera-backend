import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { StoriesService } from './stories.service';

const AUTHOR = 'a1';
const LISTING = 'l1';

type Row = Record<string, any>;

function story(overrides: Row = {}): Row {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    author_id: AUTHOR,
    listing_id: null,
    event_id: null,
    town: 'Bir',
    title: 'Monsoon in Bir',
    body: 'Paragliding and chai',
    media_urls: [],
    marketing_consent: true,
    consent_at: new Date(),
    status: 'published',
    published_at: new Date('2026-10-01T00:00:00Z'),
    created_at: new Date('2026-09-30T00:00:00Z'),
    ...overrides,
  };
}

/** Query builder double that applies the clauses the service adds, so the visibility filter is really exercised. */
function fakeQueryBuilder(rows: Row[]) {
  const clauses: string[] = [];
  const params: Row = {};
  const qb: Row = {
    where: (sql: string, p?: Row) => (
      clauses.push(sql),
      Object.assign(params, p),
      qb
    ),
    andWhere: (sql: string, p?: Row) => (
      clauses.push(sql),
      Object.assign(params, p),
      qb
    ),
    update: () => qb,
    set: (v: Row) => ((qb.values = v), qb),
    execute: async () => {
      const target = rows.find((r) => r.id === params.id);
      const consentOk =
        !clauses.some((c) => c.includes('marketing_consent = true')) ||
        target?.marketing_consent === true;
      const notWithdrawn =
        !clauses.some((c) => c.includes("status <> 'withdrawn'")) ||
        target?.status !== 'withdrawn';
      if (!target || !consentOk || !notWithdrawn) return { affected: 0 };
      for (const [k, v] of Object.entries(qb.values as Row))
        target[k] = typeof v === 'function' ? new Date() : v;
      return { affected: 1 };
    },
    orderBy: () => qb,
    addOrderBy: () => qb,
    take: () => qb,
    getOne: async () => qb.run()[0] ?? null,
    getMany: async () => qb.run(),
    run: () =>
      rows.filter(
        (r) =>
          (!clauses.some((c) => c.includes('s.status')) ||
            r.status === params.status) &&
          (!clauses.some((c) => c.includes('marketing_consent')) ||
            r.marketing_consent === true) &&
          (!params.id || r.id === params.id),
      ),
  };
  return qb;
}

function makeService(rows: Row[], access: Row = {}) {
  const storiesRepo = {
    createQueryBuilder: () => fakeQueryBuilder(rows),
    findOne: jest.fn(
      async ({ where }: Row) => rows.find((r) => r.id === where.id) ?? null,
    ),
    findOneOrFail: jest.fn(async ({ where }: Row) =>
      rows.find((r) => r.id === where.id)!,
    ),
    save: jest.fn(async (r: Row) => r),
    create: jest.fn((r: Row) => ({ id: 'new', created_at: new Date(), ...r })),
    find: jest.fn(async () => rows),
  };
  const usersRepo = {
    find: jest.fn(async () => [
      {
        id: AUTHOR,
        full_name: 'Asha Verma',
        email: 'asha@example.com',
        phone: '999',
        avatar_url: null,
      },
    ]),
  };
  const eventsRepo = { findOne: jest.fn(async () => null) };
  const accessService = {
    assertStoryAuthorOfListing: jest.fn().mockResolvedValue(undefined),
    ...access,
  };
  const config = { get: () => 'https://proj.supabase.co' };
  const service = new StoriesService(
    storiesRepo as never,
    usersRepo as never,
    eventsRepo as never,
    accessService as never,
    config as never,
  );
  return { service, storiesRepo, accessService };
}

const baseDto = {
  title: 'T',
  body: 'B',
  town: 'Kasol',
  marketingConsent: true,
};

describe('StoriesService moderation', () => {
  it('cannot publish without consent', async () => {
    const { service, storiesRepo } = makeService([
      story({ status: 'pending', marketing_consent: false }),
    ]);
    await expect(
      service.moderate('11111111-1111-4111-8111-111111111111', 'published'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storiesRepo.save).not.toHaveBeenCalled();
  });

  it('publishes a consented pending story and stamps published_at', async () => {
    const row = story({ status: 'pending', published_at: null });
    const { service } = makeService([row]);
    await service.moderate('11111111-1111-4111-8111-111111111111', 'published');
    expect(row.status).toBe('published');
    expect(row.published_at).toBeInstanceOf(Date);
  });

  it('a withdrawal that lands after the read is not overwritten by publish', async () => {
    const row = story({ status: 'pending', published_at: null });
    const { service, storiesRepo } = makeService([row]);
    // The admin read saw consent=true; the author withdraws before the UPDATE runs.
    storiesRepo.findOne.mockImplementationOnce(async () => {
      const seen = { ...row };
      row.marketing_consent = false;
      row.status = 'withdrawn';
      return seen;
    });
    await expect(
      service.moderate('11111111-1111-4111-8111-111111111111', 'published'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(row.status).toBe('withdrawn');
    expect(row.marketing_consent).toBe(false);
  });
});

describe('StoriesService consent and visibility', () => {
  it('withdrawn stories disappear from the public list and detail', async () => {
    const live = story();
    const { service } = makeService([live]);
    expect((await service.listPublic({})).stories).toHaveLength(1);

    await service.setConsent(AUTHOR, live.id, false);
    expect(live.status).toBe('withdrawn');
    expect(live.marketing_consent).toBe(false);
    expect((await service.listPublic({})).stories).toHaveLength(0);
    await expect(service.getPublic(live.id)).rejects.toThrow('Story not found');
  });

  it('a non-author cannot withdraw', async () => {
    const live = story();
    const { service, storiesRepo } = makeService([live]);
    await expect(
      service.setConsent('someone-else', live.id, false),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(storiesRepo.save).not.toHaveBeenCalled();
    expect(live.status).toBe('published');
  });

  it('exposes first name and avatar only', async () => {
    const { service } = makeService([story()]);
    const [dto] = (await service.listPublic({})).stories;
    expect(dto.authorFirstName).toBe('Asha');
    expect(JSON.stringify(dto)).not.toMatch(/Verma|asha@example|999/);
  });
});

describe('StoriesService.create', () => {
  it('sets consent_at server-side and starts pending', async () => {
    const { service, storiesRepo } = makeService([]);
    await service.create(AUTHOR, baseDto);
    expect(storiesRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        marketing_consent: true,
        consent_at: expect.any(Date),
        published_at: null,
      }),
    );
  });

  it('leaves consent_at empty when consent is declined', async () => {
    const { service, storiesRepo } = makeService([]);
    await service.create(AUTHOR, { ...baseDto, marketingConsent: false });
    expect(storiesRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ marketing_consent: false, consent_at: null }),
    );
  });

  it('rejects a missing consent flag', async () => {
    const { service } = makeService([]);
    await expect(
      service.create(AUTHOR, {
        ...baseDto,
        marketingConsent: undefined as never,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires an eligible stay when a listing is given', async () => {
    const { service, storiesRepo } = makeService([], {
      assertStoryAuthorOfListing: jest
        .fn()
        .mockRejectedValue(new ForbiddenException()),
    });
    await expect(
      service.create(AUTHOR, { ...baseDto, listingId: LISTING }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(storiesRepo.save).not.toHaveBeenCalled();
  });

  it('only accepts media from the app storage host', async () => {
    const { service } = makeService([]);
    await expect(
      service.create(AUTHOR, {
        ...baseDto,
        mediaUrls: ['https://evil.example/a.jpg'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const base = 'https://proj.supabase.co/storage/v1/object/public';
    const id = '11111111-1111-4111-8111-111111111111';
    for (const bad of [
      `${base}/stories/a.jpg`,
      `${base}/story-media/a.jpg`,
      `${base}/story-media/${id}/${id}.gif`,
      `${base}/story-media/${id}/${id}.jpg?x=1`,
      `http://proj.supabase.co/storage/v1/object/public/story-media/${id}/${id}.jpg`,
      `${base}/story-media/22222222-2222-4222-8222-222222222222/${id}.jpg`,
    ]) {
      await expect(
        service.create(id, { ...baseDto, mediaUrls: [bad] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      service.create(id, {
        ...baseDto,
        mediaUrls: [`${base}/story-media/${id}/${id}.webp`],
      }),
    ).resolves.toMatchObject({ success: true });
  });
});
