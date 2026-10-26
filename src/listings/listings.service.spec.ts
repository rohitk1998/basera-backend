import { ListingsService } from './listings.service';
import { rowToListing } from './listing-mapper';
import { normalizeListingSearch } from './listing-search.util';

type Call = [string, unknown[]];

function stubQueryBuilder(calls: Call[]) {
  const qb: any = new Proxy(
    {},
    {
      get: (_t, name: string) => {
        if (name === 'getCount') return async () => 0;
        if (name === 'getMany' || name === 'getRawMany') return async () => [];
        return (...args: unknown[]) => {
          calls.push([name, args]);
          return qb;
        };
      },
    },
  );
  return qb;
}

function makeService() {
  const calls: Call[] = [];
  const cacheKeys: string[] = [];
  const store = new Map<string, string>();
  const redis = {
    getVersion: async () => '7',
    get: async (k: string) => {
      cacheKeys.push(k);
      return store.get(k) ?? null;
    },
    set: async (k: string, v: string) => {
      store.set(k, v);
      return true;
    },
  };
  const repo: any = { createQueryBuilder: () => stubQueryBuilder(calls), query: async () => [] };
  const service = new ListingsService(repo, {} as any, {} as any, { getCachedTranslationsBatch: async () => new Map(), warmTranslation: () => {} } as any, redis as any);
  return { service, calls, cacheKeys, store };
}

const search = (raw: Record<string, unknown>) => normalizeListingSearch(raw);

describe('ListingsService.findLive', () => {
  it('returns page/pageSize in the result, bounded by default', async () => {
    const { service } = makeService();
    expect(await service.findLive(search({}))).toEqual({ listings: [], total: 0, page: 1, pageSize: 48 });
    expect(await service.findLive(search({ page: '0', pageSize: '5000' }))).toMatchObject({ page: 1, pageSize: 200 });
  });

  it('skips and takes exactly one bounded page, even when the caller passes no pagination', async () => {
    const { service, calls } = makeService();
    await service.findLive({ q: 'kasol' });
    expect(calls).toContainEqual(['skip', [0]]);
    expect(calls).toContainEqual(['take', [48]]);
    calls.length = 0;
    await service.findLive({ page: 3, pageSize: 10 });
    expect(calls).toContainEqual(['skip', [20]]);
    expect(calls).toContainEqual(['take', [10]]);
  });

  it('sorts by trust with NULLS LAST', async () => {
    const { service, calls } = makeService();
    await service.findLive({ sortByTrust: true });
    const order = calls.find(([n]) => n === 'orderBy')!;
    expect(order[1]).toEqual(["(l.draft_data->>'trustScore')::int", 'DESC', 'NULLS LAST']);
  });

  it('ANDs district, tehsil, category and the text clause', async () => {
    const { service, calls } = makeService();
    await service.findLive(search({ q: 'Kasol', district: 'kullu', tehsil: 'Bhuntar', category: 'work' }));
    const where = calls.filter(([n]) => n === 'andWhere').map(([, a]) => String(a[0]));
    expect(where.some((w) => w.includes('= :district'))).toBe(true);
    expect(where.some((w) => w.includes('= :tehsil'))).toBe(true);
    expect(where.some((w) => w.includes("'categories' @>"))).toBe(true);
    expect(where.some((w) => w.includes('ILIKE :qs0'))).toBe(true);
    const district = calls.find(([n, a]) => n === 'andWhere' && String(a[0]).includes('= :district'))!;
    expect(district[1][1]).toEqual({ district: 'kullu' });
  });

  it('filters out homes that do not allow pets when pets >= 1, and only then', async () => {
    const withPets = makeService();
    await withPets.service.findLive(search({ pets: '1' }));
    const where = withPets.calls.filter(([n]) => n === 'andWhere').map(([, a]) => String(a[0]));
    expect(where.some((w) => w.includes("'pets'") && w.includes("= 'true'"))).toBe(true);
    const without = makeService();
    await without.service.findLive(search({ guests: '2' }));
    expect(without.calls.some(([n, a]) => n === 'andWhere' && String(a[0]).includes("'pets'"))).toBe(false);
  });

  it('casts the stored value, not the key name, in a dated search', async () => {
    const { service, calls } = makeService();
    await service.findLive(search({ date: '2026-10-02', dateEnd: '2026-10-31' }));
    const where = calls.filter(([n]) => n === 'andWhere').map(([, a]) => String(a[0]));

    expect(where.length).toBeGreaterThan(0);
    for (const w of where) expect(w).not.toMatch(/->>'\w+'::/);
    expect(where.some((w) => w.includes(")::date <= :moveIn"))).toBe(true);
    expect(where.some((w) => w.includes(")::int <= (:moveOut::date - :moveIn::date)"))).toBe(true);
  });

  it('ignores an invalid district and category (they never reach the query)', async () => {
    const { service, calls } = makeService();
    await service.findLive(search({ district: 'Narnia', category: 'beach' }));
    const where = calls.filter(([n]) => n === 'andWhere').map(([, a]) => String(a[0]));
    expect(where).toEqual([]);
  });
});

describe('search cache key', () => {
  const keyFor = async (raw: Record<string, unknown>) => {
    const { service, cacheKeys } = makeService();
    await service.findLive(search(raw));
    return cacheKeys[0];
  };

  it('includes the version and is stable for identical params', async () => {
    const a = await keyFor({ q: 'kasol' });
    expect(a).toContain(':v7:');
    expect(await keyFor({ q: 'kasol' })).toBe(a);
  });

  it('is the same whether pageSize is omitted or spelled out as the default', async () => {
    expect(await keyFor({})).toBe(await keyFor({ page: '1', pageSize: '48' }));
  });

  it('varies by every new param and by the facets flag', async () => {
    const base = await keyFor({});
    const variants = await Promise.all([
      keyFor({ q: 'kasol' }),
      keyFor({ district: 'Kullu' }),
      keyFor({ tehsil: 'Bhuntar' }),
      keyFor({ category: 'work' }),
      keyFor({ guests: '2' }),
      keyFor({ pets: '1' }),
      keyFor({ sort: 'trust' }),
      keyFor({ locale: 'hi' }),
      keyFor({ page: '2' }),
      keyFor({ pageSize: '10' }),
      keyFor({ facets: '1' }),
    ]);
    const all = new Set([base, ...variants]);
    expect(all.size).toBe(variants.length + 1);
  });

  it('treats the town / location aliases as the same search as q', async () => {
    const q = await keyFor({ q: 'Manali' });
    expect(await keyFor({ town: 'Manali' })).toBe(q);
    expect(await keyFor({ location: 'Manali' })).toBe(q);
  });

  it('serves a repeat from the cache without querying again', async () => {
    const { service, calls } = makeService();
    await service.findLive(search({ q: 'kasol' }));
    const firstCalls = calls.length;
    await service.findLive(search({ q: 'kasol' }));
    expect(calls.length).toBe(firstCalls);
  });

  it('does not cache a dated search (live booking state)', async () => {
    const { service, cacheKeys } = makeService();
    await service.findLive(search({ date: '2026-11-01' }));
    expect(cacheKeys).toEqual([]);
  });
});

describe('rowToListing display vs filter consistency', () => {
  const row = (property_details: Record<string, unknown>) =>
    ({ id: 'abcdef1234', status: 'live', draft_data: { property_details } }) as any;

  it('shows no categories when the host stored none, so it never advertises one the filter cannot match', () => {
    expect(rowToListing(row({ title: 'x' })).categories).toEqual([]);
    expect(rowToListing(row({ title: 'x', categories: [] })).categories).toEqual([]);
    expect(rowToListing(row({ title: 'x', categories: ['quiet'] })).categories).toEqual(['quiet']);
  });

  it('falls back from town to tehsil to district to empty — never to Dharamshala', () => {
    expect(rowToListing(row({ town: 'Kasol', tehsil: 'Bhuntar', district: 'Kullu' })).town).toBe('Kasol');
    expect(rowToListing(row({ tehsil: 'Bhuntar', district: 'Kullu' })).town).toBe('Bhuntar');
    expect(rowToListing(row({ district: 'Kullu' })).town).toBe('Kullu');
    const none = rowToListing(row({ title: 'Nowhere' }));
    expect(none.town).toBe('');
    expect(none.fullLocation).toBe('Nowhere, Himachal Pradesh');
    expect(none.description).not.toContain(' in ,');
  });
});

describe('ListingsService facets', () => {
  const rawRows = [
    { district: 'Kangra', place: 'Dharamshala', count: '2', min_rate: null, min_disc: null, cover_url: 'late.jpg', cover_at: '2026-02-01T00:00:00Z' },
    { district: 'Kangra', place: 'Palampur', count: '1', min_rate: null, min_disc: null, cover_url: 'early.jpg', cover_at: '2026-01-01T00:00:00Z' },
    { district: '', place: null, count: '1', min_rate: null, min_disc: null, cover_url: null, cover_at: null },
  ];
  const build = (getRawMany: () => Promise<unknown[]>) => {
    const { service, store } = makeService();
    (service as any).listings.createQueryBuilder = () => {
      const qb: any = new Proxy(
        {},
        { get: (_t, n: string) => (n === 'getRawMany' ? getRawMany : n === 'getCount' ? async () => 0 : n === 'getMany' ? async () => [] : () => qb) },
      );
      return qb;
    };
    return { service, store };
  };

  it('derives districts (counts and earliest cover) and places from one scan, and caches it', async () => {
    let scans = 0;
    const { service } = build(async () => (scans++, rawRows));
    const first = await service.findLive(search({ facets: '1', pageSize: '1' }));
    expect(first.facets?.districts).toEqual([{ name: 'Kangra', count: 3, coverUrl: 'early.jpg' }]);
    expect(first.facets?.places.map((p) => p.tehsil)).toEqual(['Dharamshala', 'Palampur']);
    expect(scans).toBe(1);
    await service.findLive(search({ facets: '1', pageSize: '2' }));
    expect(scans).toBe(1);
  });

  it('never caches a failed facets query', async () => {
    const { service, store } = build(async () => {
      throw new Error('db down');
    });
    await expect(service.findLive(search({ facets: '1' }))).rejects.toThrow('db down');
    expect([...store.keys()].filter((k) => k.includes('facets'))).toEqual([]);
  });
});
