import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';
import { discoveredToListing, rowToListing } from './listing-mapper';
import { normalizeListingSearch } from './listing-search.util';
import { discoveredGridSql } from '../discovery/discovered-predicate';
import { DiscoveredDetailsService } from '../discovery/discovered-details.service';

const OWNER_ARM = "l.status = 'live' AND l.is_discovered = false";
const GRID = discoveredGridSql('l');

const discRow: any = {
  id: 'd1', host_id: null, status: 'discovered', is_discovered: true, external_place_id: 'place-secret-id-1',
  discovery_source: 'google_places', discovery_destination: 'Manali',
  disc_district: 'Kullu', disc_tehsil: 'Manali', disc_lat: 32.24, disc_lng: 77.19,
  draft_data: { discovery: { source: 'google_places', placeId: 'place-secret-id-1', lat: 32.24, lng: 77.19, destination: 'Manali' } },
  created_at: new Date('2026-11-01'),
};
const ownerRow: any = {
  id: 'o1', host_id: 'h1', status: 'live', is_discovered: false, created_at: new Date('2026-11-02'),
  draft_data: { property_details: { title: 'Owner place', district: 'Kullu', tehsil: 'Manali' } },
};

type Rec = { wheres: string[]; params: Record<string, unknown>; selects: string[]; orders: string[]; groups: string[] };

function harness(opts: { rows?: any[]; rawOne?: any; rawMany?: any[] | (() => any[]); failRaw?: boolean } = {}) {
  const qbs: Rec[] = [];
  const store = new Map<string, string>();
  const sets: [string, string][] = [];
  const gets: string[] = [];
  const mk = (): any => {
    const rec: Rec = { wheres: [], params: {}, selects: [], orders: [], groups: [] };
    qbs.push(rec);
    const qb: any = new Proxy({}, {
      get: (_t, n: string) => {
        if (n === 'getCount') return async () => 0;
        if (n === 'getMany') return async () => opts.rows ?? [];
        if (n === 'getRawOne') return async () => opts.rawOne ?? { total: 0, owner_total: 0 };
        if (n === 'getRawMany') {
          return async () => {
            if (opts.failRaw) throw new Error('boom');
            return typeof opts.rawMany === 'function' ? opts.rawMany() : opts.rawMany ?? [];
          };
        }
        return (...a: any[]) => {
          if (['where', 'andWhere', 'orWhere'].includes(n)) {
            if (a[0] && typeof a[0].whereFactory === 'function') a[0].whereFactory(qb);
            else { rec.wheres.push(String(a[0])); Object.assign(rec.params, a[1] ?? {}); }
          } else if (n === 'select' || n === 'addSelect') rec.selects.push(a[1] ? `${a[0]} AS ${a[1]}` : String(a[0]));
          else if (n === 'orderBy' || n === 'addOrderBy') rec.orders.push(a.filter((x) => x !== undefined).join(' '));
          else if (n === 'groupBy' || n === 'addGroupBy') rec.groups.push(String(a[0]));
          return qb;
        };
      },
    });
    return qb;
  };
  const repo: any = { createQueryBuilder: () => mk(), query: async () => [] };
  const redis: any = {
    getVersion: async () => '7',
    get: async (k: string) => { gets.push(k); return store.get(k) ?? null; },
    set: jest.fn(async (k: string, v: string) => { sets.push([k, v]); store.set(k, v); return true; }),
  };
  const translations: any = { getCachedTranslationsBatch: jest.fn(async () => new Map()), warmTranslation: jest.fn() };
  const service = new ListingsService(repo, {} as any, {} as any, translations, redis);
  const allWheres = () => qbs.flatMap((q) => q.wheres);
  return { service, qbs, redis, sets, gets, translations, allWheres };
}

const flagOn = (extra: Record<string, unknown> = {}) => normalizeListingSearch({ discovered: '1', ...extra });

describe('flag off: the query is exactly today\'s', () => {
  it('only the owner predicate, no disc_* anywhere, plain count, response shape unchanged', async () => {
    const h = harness({ rows: [ownerRow] });
    const res: any = await h.service.findLive(normalizeListingSearch({}));
    expect(h.allWheres()).toEqual([OWNER_ARM, OWNER_ARM]);
    expect(h.qbs.flatMap((q) => [...q.wheres, ...q.selects, ...q.orders]).join(' ')).not.toMatch(/disc_|is_discovered ASC/);
    expect(Object.keys(res).sort()).toEqual(['listings', 'page', 'pageSize', 'total']);
  });
});

describe('flag on: where clause', () => {
  it('has the owner arm verbatim plus the discovered grid predicate', async () => {
    const h = harness();
    await h.service.findLive(flagOn());
    const w = h.allWheres();
    expect(w).toContain(OWNER_ARM);
    expect(w).toContain(GRID);
  });

  it.each([
    ['category', { category: 'views' }],
    ['guests', { guests: '2' }],
    ['pets', { pets: '1' }],
    ['minPrice', { minPrice: '1000' }],
    ['maxPrice', { maxPrice: '9000' }],
    ['bedrooms', { bedrooms: '2' }],
    ['propertyType', { propertyType: 'Apartment' }],
    ['moveIn', { date: '2026-12-01' }],
    ['moveIn+moveOut', { date: '2026-12-01', dateEnd: '2026-12-20' }],
  ])('%s removes the discovered arm (owner-only query)', async (_n, raw) => {
    const h = harness();
    await h.service.findLive(flagOn(raw));
    const w = h.allWheres().join(' | ');
    expect(w).toContain(OWNER_ARM);
    expect(w).not.toContain(GRID);
    expect(w).not.toMatch(/disc_/);
  });

  it('district and tehsil use lower(l.disc_*) with d_ params, separate from the owner params', async () => {
    const h = harness();
    await h.service.findLive(flagOn({ district: 'kullu', tehsil: 'Manali' }));
    const w = h.allWheres();
    expect(w).toContain('lower(l.disc_district) = :d_district');
    expect(w).toContain('lower(l.disc_tehsil) = :d_tehsil');
    const params = Object.assign({}, ...h.qbs.map((q) => q.params));
    expect(params.d_district).toBe('kullu');
    expect(params.d_tehsil).toBe('manali');
    expect(params.district).toBe('kullu'); // owner arm keeps its own name
  });

  it('q matches only our own location columns, never title, name or address', async () => {
    const h = harness();
    await h.service.findLive(flagOn({ q: 'kasol' }));
    const disc = h.allWheres().filter((s) => s.includes('l.disc_district ILIKE'));
    expect(disc.length).toBeGreaterThan(0);
    for (const s of disc) {
      expect(s).not.toMatch(/title|name|address|draft_data|description/i);
      expect(s).toContain('l.discovery_destination ILIKE');
      expect(s).toContain('l.disc_tehsil ILIKE');
      expect(s).toMatch(/lower\(l\.disc_district\) = :d_q/); // alias pair arm (kasol -> Kullu / Bhuntar)
    }
    const params = Object.assign({}, ...h.qbs.map((q) => q.params));
    expect(Object.keys(params).filter((k) => k.startsWith('d_q')).length).toBeGreaterThan(0);
  });
});

describe('flag on: ordering', () => {
  it.each([
    ['default', {}],
    ['price_asc', { sort: 'price_asc' }],
    ['price_desc', { sort: 'price_desc' }],
    ['trust', { sort: 'trust' }],
  ] as [string, Record<string, string>][])('%s sort starts with l.is_discovered ASC and ends with created_at, id', async (_n, raw) => {
    const h = harness();
    await h.service.findLive(flagOn(raw));
    const rowsQb = h.qbs.find((q) => q.orders.length > 0)!;
    expect(rowsQb.orders[0]).toMatch(/^l\.is_discovered(\s|,)*ASC/i);
    expect(rowsQb.orders.length).toBeGreaterThanOrEqual(3);
    expect(rowsQb.orders[rowsQb.orders.length - 1]).toMatch(/^l\.id DESC/);
    if (raw.sort === 'price_asc') expect(rowsQb.orders[1]).toMatch(/ASC/);
    if (raw.sort === 'price_desc') expect(rowsQb.orders[1]).toMatch(/DESC/);
  });

  it('flag off keeps today\'s ordering (no is_discovered)', async () => {
    const h = harness();
    await h.service.findLive(normalizeListingSearch({}));
    expect(h.qbs.find((q) => q.orders.length)!.orders).toEqual(['l.created_at DESC', 'l.id DESC']);
  });
});

describe('flag on: counts and mapping', () => {
  it('counts total and owner_total in one query and derives discoveredTotal', async () => {
    const h = harness({ rawOne: { total: 10, owner_total: 4 } });
    const res: any = await h.service.findLive(flagOn());
    expect(h.qbs.flatMap((q) => q.selects).join(' ')).toContain('count(*) FILTER (WHERE NOT l.is_discovered)');
    expect(res).toMatchObject({ total: 10, ownerTotal: 4, discoveredTotal: 6 });
  });

  it('maps discovered rows to stubs and owner rows to full listings; owner first as returned', async () => {
    const h = harness({ rows: [ownerRow, discRow] });
    const res: any = await h.service.findLive(flagOn());
    expect(res.listings[0]).toMatchObject({ id: 'o1', verified: true });
    expect(res.listings[1]).toMatchObject({ id: 'd1', discovered: true, verified: false, titleIsFallback: true });
  });

  it('skips discovered rows in translation lookups and warming', async () => {
    const h = harness({ rows: [ownerRow, discRow] });
    await h.service.findLive(flagOn({ locale: 'hi' }));
    const batchArg: any[] = (h.translations.getCachedTranslationsBatch as jest.Mock).mock.calls[0][0];
    expect(batchArg.map((r) => r.row.id)).toEqual(['o1']);
    for (const c of (h.translations.warmTranslation as jest.Mock).mock.calls) expect(c[0].id).not.toBe('d1');
  });
});

describe('cache keys', () => {
  it('the search key differs with includeDiscovered, and hydrate never reaches it', async () => {
    const off = harness();
    await off.service.findLive(normalizeListingSearch({}));
    const on = harness();
    await on.service.findLive(flagOn());
    const on2 = harness();
    await on2.service.findLive({ ...flagOn(), hydrate: false });
    const on3 = harness();
    await on3.service.findLive({ ...flagOn(), hydrate: true });
    const key = (h: ReturnType<typeof harness>) => h.gets.find((k) => k.startsWith('listings:search:'))!;
    expect(key(off)).not.toBe(key(on));
    expect(key(on)).toBe(key(on2));
    expect(key(on)).toBe(key(on3));
    expect(key(on)).not.toContain('hydrate');
    expect(key(on)).toContain('includeDiscovered');
    expect(key(off)).not.toContain('includeDiscovered');
  });

  it('the facets key differs with includeDiscovered', async () => {
    const off = harness();
    await off.service.findLive(normalizeListingSearch({ facets: '1' }));
    const on = harness();
    await on.service.findLive(flagOn({ facets: '1' }));
    const key = (h: ReturnType<typeof harness>) => h.gets.find((k) => k.startsWith('listings:facets:'))!;
    expect(key(off)).toBeDefined();
    expect(key(on)).toBeDefined();
    expect(key(off)).not.toBe(key(on));
  });

  it('hydrate does not defeat in-flight coalescing', async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.service.findLive({ ...flagOn(), hydrate: true }),
      h.service.findLive({ ...flagOn(), hydrate: false }),
    ]);
    expect(a).toBe(b);
  });
});

describe('discoveredToListing', () => {
  it('is an unverified, host-less stub built only from our own columns', () => {
    const l: any = discoveredToListing(discRow);
    expect(l).toMatchObject({
      id: 'd1', discovered: true, verified: false, title: 'Homestay in Manali', titleIsFallback: true,
      town: 'Manali', district: 'Kullu', tehsil: 'Manali', fullLocation: 'Manali, Kullu',
      coords: { lat: 32.24, lng: 77.19 }, photos: [], rating: null, reviewCount: null,
      dailyBaseRate: 0, monthlyDiscountPct: 0, bedrooms: 0, bathrooms: 0, trust: 0, amenities: [],
      description: '', availableFrom: '', cancellation: 'moderate', placeId: 'place-secret-id-1',
    });
    for (const k of ['host', 'phone', 'address', 'mapsUrl', 'booking', 'bookingId']) expect(l).not.toHaveProperty(k);
  });

  it('falls back to the district when there is no tehsil, and to null coords when missing', () => {
    const l: any = discoveredToListing({ ...discRow, disc_tehsil: null, disc_lat: null, disc_lng: null });
    expect(l.title).toBe('Homestay in Kullu');
    expect(l.town).toBe('Kullu');
    expect(l.fullLocation).toBe('Kullu');
    expect(l.coords).toBeNull();
  });

  it('is never marked verified even if the row were live (mapper guard)', () => {
    expect(rowToListing({ ...discRow, status: 'live' }).verified).toBe(false);
    expect((discoveredToListing({ ...discRow, status: 'live' }) as any).verified).toBe(false);
  });
});

describe('facets with discovered stays', () => {
  const when = new Date('2026-11-01');
  const raw = () => [
    { district: 'Kullu', place: 'Manali', count: '5', verified_count: '2', min_rate: '1000', min_disc: '40', cover_url: 'https://img/a.jpg', cover_at: when },
    { district: 'Kullu', place: 'Bhuntar', count: '1', verified_count: '0', min_rate: null, min_disc: null, cover_url: null, cover_at: null },
    { district: 'Kangra', place: 'Baijnath', count: '3', verified_count: '0', min_rate: null, min_disc: null, cover_url: null, cover_at: null },
  ];

  it('sums verified and discovered per district and place; discovered-only buckets have null cover and rent', async () => {
    const h = harness({ rawMany: raw });
    const { facets } = (await h.service.findLive(flagOn({ facets: '1' }))) as any;
    const kullu = facets.districts.find((d: any) => d.name === 'Kullu');
    const kangra = facets.districts.find((d: any) => d.name === 'Kangra');
    expect(kullu).toMatchObject({ count: 6, verifiedCount: 2, discoveredCount: 4, coverUrl: 'https://img/a.jpg' });
    expect(typeof kullu.fromMonthlyRent).toBe('number');
    expect(kangra).toMatchObject({ count: 3, verifiedCount: 0, discoveredCount: 3, coverUrl: null, fromMonthlyRent: null });
    const bhuntar = facets.places.find((p: any) => p.tehsil === 'Bhuntar');
    expect(bhuntar).toMatchObject({ district: 'Kullu', count: 1, verifiedCount: 0, discoveredCount: 1, coverUrl: null, fromMonthlyRent: null });
    for (const f of [...facets.districts, ...facets.places]) expect(f.count).toBe(f.verifiedCount + f.discoveredCount);
  });

  it('groups discovered rows by our own columns and keeps covers and rent owner-only', async () => {
    const h = harness({ rawMany: raw });
    await h.service.findLive(flagOn({ facets: '1' }));
    const sql = h.qbs.flatMap((q) => [...q.selects, ...q.groups]).join(' ');
    expect(sql).toContain('l.disc_district');
    expect(sql).toContain('l.disc_tehsil');
    expect(sql).toMatch(/FILTER \(WHERE NOT l\.is_discovered/);
    expect(sql).toContain('verified_count');
  });

  it('owner-only facets keep their old shape (no verified/discovered counts)', async () => {
    const h = harness({ rawMany: () => [{ district: 'Kullu', place: 'Manali', count: '2', min_rate: '1000', min_disc: '40', cover_url: null, cover_at: null }] });
    const { facets } = (await h.service.findLive(normalizeListingSearch({ facets: '1' }))) as any;
    expect(facets.districts[0]).not.toHaveProperty('discoveredCount');
    expect(facets.places[0]).not.toHaveProperty('verifiedCount');
  });

  it('a failed facets query is never cached', async () => {
    const h = harness({ failRaw: true });
    await h.service.findLive(flagOn({ facets: '1' })).catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    expect(h.sets.filter(([k]) => k.startsWith('listings:facets:'))).toEqual([]);
  });

  it('a successful facets query is cached under the flagged key', async () => {
    const h = harness({ rawMany: raw });
    await h.service.findLive(flagOn({ facets: '1' }));
    expect(h.sets.some(([k]) => k.startsWith('listings:facets:'))).toBe(true);
  });
});

describe('redis never sees Google data', () => {
  it('cached search results are stubs; hydrating later writes nothing to redis', async () => {
    const h = harness({ rows: [discRow] });
    const res = await h.service.findLive(flagOn());
    const before = h.sets.length;
    expect(before).toBeGreaterThan(0);
    const places: any = {
      sourceKey: 'google_places', blockedReason: () => null,
      getDetails: jest.fn(async () => ({ name: 'Pine Cottage GOOGLE', address: '12 Mall Rd GOOGLE', rating: 4.9, ratingCount: 9, mapsUrl: 'm', photoName: 'p', photoNames: ['p'], summary: 's', amenities: [], reviews: [] })),
    };
    const usage: any = { remaining: async () => 100 };
    const details = new DiscoveredDetailsService(places, usage, { query: async () => [] } as any);
    const out: any[] = await details.hydrateListings(res.listings, { hydrate: true });
    expect(out[0].title).toBe('Pine Cottage GOOGLE');
    expect(h.sets.length).toBe(before);
    for (const [, v] of h.sets) expect(v).not.toMatch(/GOOGLE|Pine Cottage|Mall Rd/);
    expect(res.listings[0].title).toBe('Homestay in Manali'); // cached/in-memory result untouched
  });
});

describe('ListingsController.search hydration', () => {
  const make = (result: any) => {
    const listingsService: any = { findLive: jest.fn(async () => result) };
    const hydrate = jest.fn(async (l: any[]) => l.map((x) => ({ ...x, hydrated: true })));
    const details: any = { hydrateListings: hydrate };
    const ctl = new ListingsController(listingsService, {} as any, {} as any, details, {} as any);
    return { ctl, hydrate, listingsService };
  };
  const result = { listings: [{ id: 'd1', discovered: true }], total: 1, page: 1, pageSize: 24 };

  it('passes hydrate=true only for includeDiscovered and returns a new listings array', async () => {
    const t = make(result);
    const res: any = await t.ctl.search({ discovered: '1' });
    expect(t.hydrate).toHaveBeenCalledWith(result.listings, { hydrate: true });
    expect(res.success).toBe(true);
    expect(res.listings[0].hydrated).toBe(true);
    expect(result.listings[0]).not.toHaveProperty('hydrated');
  });

  it('honours hydrate=0 and never hydrates without the flag', async () => {
    const a = make(result);
    await a.ctl.search({ discovered: '1', hydrate: '0' });
    expect(a.hydrate).toHaveBeenCalledWith(result.listings, { hydrate: false });
    const b = make(result);
    await b.ctl.search({ hydrate: '1' });
    expect(b.hydrate).toHaveBeenCalledWith(result.listings, { hydrate: false });
  });

  it('the service sees no hydrate-dependent behaviour: includeDiscovered is passed through', async () => {
    const t = make(result);
    await t.ctl.search({ discovered: 'true' });
    expect(t.listingsService.findLive.mock.calls[0][0].includeDiscovered).toBe(true);
  });
});

describe('discoveredToListing research price', () => {
  const { discoveredToListing } = require('./listing-mapper');
  const row = (pd: any) => ({ id: 'd1', disc_district: 'Kullu', disc_tehsil: 'Manali', disc_lat: 32.2, disc_lng: 77.1, external_place_id: 'p1', draft_data: pd === undefined ? {} : { property_details: pd } });

  it('carries our own research price, title and details onto the card, defaulting to the 40% monthly discount used by facets', () => {
    const l = discoveredToListing(row({ dailyBaseRate: 1317, bedrooms: 1, bathrooms: 1, maxGuests: 2, title: 'Afsana Homestay Manali' }));
    expect(l).toMatchObject({ dailyBaseRate: 1317, monthlyDiscountPct: 40, bedrooms: 1, bathrooms: 1, maxGuests: 2, discovered: true, titleIsFallback: false });
    expect(l.title).toBe('Afsana Homestay Manali');
  });

  it('leaves price at 0 (request only) when there is no research data, and ignores junk values', () => {
    expect(discoveredToListing(row(undefined)).dailyBaseRate).toBe(0);
    expect(discoveredToListing(row({ dailyBaseRate: -5, bedrooms: 'x', monthlyDiscountPct: 500 })))
      .toMatchObject({ dailyBaseRate: 0, bedrooms: 0, monthlyDiscountPct: 0 });
  });
});
