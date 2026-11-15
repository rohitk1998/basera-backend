import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { EventsService, slugify } from './events.service';

function makeQb(rows: unknown[] = []) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'andWhere', 'orderBy', 'addOrderBy', 'limit']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

const ROW = {
  id: 'e1',
  slug: 'kullu-dussehra',
  title: 'Kullu Dussehra',
  description: 'Week-long festival',
  town: 'Kullu',
  district: 'Kullu',
  starts_on: '2026-10-20',
  ends_on: '2026-10-26',
  lat: null,
  lng: null,
  image_url: null,
  status: 'published',
};

function makeService(
  opts: {
    qb?: ReturnType<typeof makeQb>;
    found?: unknown;
    saveErr?: unknown;
  } = {},
) {
  const qb = opts.qb ?? makeQb();
  const repo = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    findOne: jest.fn().mockResolvedValue(opts.found ?? null),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((v: unknown) => v),
    save: opts.saveErr
      ? jest.fn().mockRejectedValue(opts.saveErr)
      : jest.fn(async (v: Record<string, unknown>) => ({ id: 'new', ...v })),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  return { service: new EventsService(repo as never), repo, qb };
}

describe('EventsService.listPublic', () => {
  it('returns only published events from today, soonest first, as EventDto', async () => {
    const qb = makeQb([ROW]);
    const { service } = makeService({ qb });
    const out = await service.listPublic({});
    expect(qb.where).toHaveBeenCalledWith('e.status = :status', {
      status: 'published',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('e.ends_on >= :from', {
      from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(qb.orderBy).toHaveBeenCalledWith('e.starts_on', 'ASC');
    expect(out).toEqual([
      {
        id: 'e1',
        slug: 'kullu-dussehra',
        title: 'Kullu Dussehra',
        description: 'Week-long festival',
        town: 'Kullu',
        district: 'Kullu',
        startsOn: '2026-10-20',
        endsOn: '2026-10-26',
        imageUrl: null,
      },
    ]);
  });

  it('honours from, town and limit', async () => {
    const qb = makeQb();
    const { service } = makeService({ qb });
    await service.listPublic({ from: '2026-12-01', town: ' Bir ', limit: 5 });
    expect(qb.andWhere).toHaveBeenCalledWith('e.ends_on >= :from', {
      from: '2026-12-01',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('LOWER(e.town) = LOWER(:town)', {
      town: 'Bir',
    });
    expect(qb.limit).toHaveBeenCalledWith(5);
  });
});

describe('EventsService.getPublicBySlug', () => {
  it('looks up published events only', async () => {
    const { service, repo } = makeService({ found: ROW });
    await service.getPublicBySlug('kullu-dussehra');
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { slug: 'kullu-dussehra', status: 'published' },
    });
  });

  it('404s when missing', async () => {
    const { service } = makeService();
    await expect(service.getPublicBySlug('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('EventsService writes', () => {
  const base = {
    title: 'Bir Billing Season',
    description: 'Paragliding',
    town: 'Bir',
    district: 'Kangra',
    startsOn: '2026-10-01',
    endsOn: '2026-11-30',
  };

  it('creates a draft with a generated slug by default', async () => {
    const { service, repo } = makeService();
    await service.create(base);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'bir-billing-season',
        status: 'draft',
        starts_on: '2026-10-01',
      }),
    );
  });

  it('rejects an end date before the start date', async () => {
    const { service } = makeService();
    await expect(
      service.create({ ...base, endsOn: '2026-09-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps a duplicate slug to 409', async () => {
    const { service } = makeService({ saveErr: { code: '23505' } });
    await expect(service.create(base)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('update validates the merged date range', async () => {
    const { service } = makeService({ found: { ...ROW } });
    await expect(
      service.update('e1', { endsOn: '2026-10-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('update clears image with null and publishes', async () => {
    const { service, repo } = makeService({
      found: { ...ROW, image_url: 'https://x/y.jpg' },
    });
    await service.update('e1', { imageUrl: null, status: 'draft' });
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ image_url: null, status: 'draft' }),
    );
  });

  it('remove 404s when nothing was deleted', async () => {
    const { service, repo } = makeService();
    repo.delete.mockResolvedValue({ affected: 0 });
    await expect(service.remove('e1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Minjar Fair, Chamba!')).toBe('minjar-fair-chamba');
  });
});
