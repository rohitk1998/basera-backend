import { DETAILS_TTL_MS, DiscoveredDetailsService, HYDRATE_MAX, NEGATIVE_TTL_MS } from './discovered-details.service';

const MIN = 60_000;

function details(name: string | null = 'Pine Cottage', photos = 2): any {
  return {
    name, address: '12 Mall Rd, Manali', rating: 4.8, ratingCount: 120, mapsUrl: 'https://maps.google.com/?cid=1',
    photoName: photos ? 'places/x/photos/1' : null, photoNames: Array.from({ length: photos }, (_, i) => `places/x/photos/${i}`),
    summary: 'Cosy', amenities: ['Pets allowed'], reviews: [],
  };
}

function make(opts: { remaining?: number; blocked?: string | null; getDetails?: (id: string, budget: number, signal?: AbortSignal) => Promise<any> } = {}) {
  const places: any = {
    sourceKey: 'google_places',
    blockedReason: jest.fn(() => opts.blocked ?? null),
    getDetails: jest.fn(opts.getDetails ?? (async () => details())),
  };
  const usage: any = { remaining: jest.fn(async () => opts.remaining ?? 1000), reserve: jest.fn(async () => true) };
  return { svc: new DiscoveredDetailsService(places, usage, { query: async () => [] } as any), places, usage };
}

const stub = (n: number, extra: Record<string, unknown> = {}): any => ({
  id: `id-${n}`, discovered: true, verified: false, title: 'Homestay in Manali', titleIsFallback: true,
  town: 'Manali', district: 'Kullu', tehsil: 'Manali', photos: [], rating: null, reviewCount: null, placeId: `place-${n}-xxxxxxxx`, ...extra,
});

/** Run an async op while advancing fake time so timers inside it fire. */
async function settle<T>(p: Promise<T>, ms = 0): Promise<T> {
  await jest.advanceTimersByTimeAsync(ms);
  return p;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-21T10:00:00Z'));
});
afterEach(() => jest.useRealTimers());

describe('DiscoveredDetailsService.get cache', () => {
  it('makes one Google call per place id per 30 minutes, then another after 31', async () => {
    const { svc, places } = make();
    await svc.get('place-a-xxxxxxxx');
    await svc.get('place-a-xxxxxxxx');
    expect(places.getDetails).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(DETAILS_TTL_MS - MIN);
    await svc.get('place-a-xxxxxxxx');
    expect(places.getDetails).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2 * MIN);
    await svc.get('place-a-xxxxxxxx');
    expect(places.getDetails).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent calls for the same id', async () => {
    let release!: (d: any) => void;
    const { svc, places } = make({ getDetails: () => new Promise((r) => { release = r; }) });
    const ps = [svc.get('place-a-xxxxxxxx'), svc.get('place-a-xxxxxxxx'), svc.get('place-a-xxxxxxxx')];
    await jest.advanceTimersByTimeAsync(0);
    release(details());
    const out = await Promise.all(ps);
    expect(places.getDetails).toHaveBeenCalledTimes(1);
    expect(out.every((d) => d?.name === 'Pine Cottage')).toBe(true);
  });

  it('caches a transient failure (null) for only 2 minutes', async () => {
    const { svc, places } = make({ getDetails: async () => null });
    expect(NEGATIVE_TTL_MS).toBe(2 * MIN);
    await svc.get('place-a-xxxxxxxx');
    await jest.advanceTimersByTimeAsync(MIN);
    await svc.get('place-a-xxxxxxxx');
    expect(places.getDetails).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(MIN + 1000);
    await svc.get('place-a-xxxxxxxx');
    expect(places.getDetails).toHaveBeenCalledTimes(2);
  });

  it('a thrown getDetails is treated as a miss, never an exception', async () => {
    const { svc } = make({ getDetails: async () => { throw new Error('boom'); } });
    await expect(svc.get('place-a-xxxxxxxx')).resolves.toBeNull();
  });

  it('budget exhausted: no Google call, no reserve(), negative until UTC midnight', async () => {
    const { svc, places, usage } = make({ remaining: 0 });
    await expect(svc.get('place-a-xxxxxxxx')).resolves.toBeNull();
    expect(places.getDetails).not.toHaveBeenCalled();
    expect(usage.reserve).not.toHaveBeenCalled();
    usage.remaining.mockResolvedValue(500); // budget restored mid-day: still negative until midnight
    await jest.advanceTimersByTimeAsync(5 * 60 * MIN);
    await svc.get('place-a-xxxxxxxx');
    expect(places.getDetails).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(9 * 60 * MIN); // 10:00 + 14h = after 00:00 UTC
    await svc.get('place-a-xxxxxxxx');
    expect(places.getDetails).toHaveBeenCalledTimes(1);
  });

  it('breaker open / blocked: no Google call and no budget lookup', async () => {
    const { svc, places, usage } = make({ blocked: 'blocked: circuit breaker open' });
    await expect(svc.get('place-a-xxxxxxxx')).resolves.toBeNull();
    expect(places.getDetails).not.toHaveBeenCalled();
    expect(usage.remaining).not.toHaveBeenCalled();
    expect(usage.reserve).not.toHaveBeenCalled();
  });

  it('passes an AbortSignal and gives up on a hung call after 2.5 s', async () => {
    let signal: AbortSignal | undefined;
    const { svc } = make({ getDetails: (_i, _b, s) => { signal = s; return new Promise(() => undefined); } });
    const p = svc.get('place-a-xxxxxxxx');
    await jest.advanceTimersByTimeAsync(2499);
    expect(signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(2);
    await expect(p).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  it('bounds the cache at 1000 entries', async () => {
    const { svc, places } = make();
    for (let i = 0; i < 1005; i++) await svc.get(`place-${i}-xxxxxxxx`);
    expect(places.getDetails).toHaveBeenCalledTimes(1005);
    await svc.get('place-1004-xxxxxxxx'); // newest still cached
    expect(places.getDetails).toHaveBeenCalledTimes(1005);
    await svc.get('place-0-xxxxxxxx'); // oldest was evicted
    expect(places.getDetails).toHaveBeenCalledTimes(1006);
  });
});

describe('hydrateMany limits', () => {
  it('never runs more than 4 Google calls at once', async () => {
    let live = 0;
    let peak = 0;
    const { svc, places } = make({
      getDetails: () => new Promise((resolve) => {
        live++;
        peak = Math.max(peak, live);
        setTimeout(() => { live--; resolve(details()); }, 100);
      }),
    });
    const p = svc.hydrateMany(Array.from({ length: 10 }, (_, i) => `place-${i}-xxxxxxxx`));
    for (let i = 0; i < 4; i++) await jest.advanceTimersByTimeAsync(100);
    const out = await p;
    expect(peak).toBe(4);
    expect(places.getDetails).toHaveBeenCalledTimes(10);
    expect(out.size).toBe(10);
  });

  it('returns fallbacks (null) at the 3 s deadline when Google hangs', async () => {
    const { svc } = make({ getDetails: () => new Promise(() => undefined) });
    const p = svc.hydrateMany(Array.from({ length: 8 }, (_, i) => `place-${i}-xxxxxxxx`));
    await jest.advanceTimersByTimeAsync(3001);
    const out = await p;
    expect([...out.values()].every((v) => v === null)).toBe(true);
    expect(out.size).toBe(8);
  });

  it('dedupes repeated place ids', async () => {
    const { svc, places } = make();
    const p = svc.hydrateMany(['place-a-xxxxxxxx', 'place-a-xxxxxxxx', 'place-b-xxxxxxxx']);
    await jest.advanceTimersByTimeAsync(0);
    await p;
    expect(places.getDetails).toHaveBeenCalledTimes(2);
  });
});

describe('hydrateListings', () => {
  it('hydrates at most 24 discovered cards per call', async () => {
    const { svc, places } = make();
    const input = Array.from({ length: 30 }, (_, i) => stub(i));
    const out = await settle(svc.hydrateListings(input, { hydrate: true }));
    expect(HYDRATE_MAX).toBe(24);
    expect(places.getDetails).toHaveBeenCalledTimes(24);
    expect(out.filter((l) => l.titleIsFallback === false)).toHaveLength(24);
    expect(out[24].titleIsFallback).toBe(true);
    expect(out[24].title).toBe('Homestay in Manali');
  });

  it('sets the live title, a proxied first photo and the live rating, never address/reviews/mapsUrl', async () => {
    const { svc } = make();
    const [l] = (await settle(svc.hydrateListings([stub(1)], { hydrate: true }))) as any[];
    expect(l.title).toBe('Pine Cottage');
    expect(l.titleIsFallback).toBe(false);
    expect(l.photos).toEqual([expect.objectContaining({ url: '/api/discovered/id-1/photo?i=0' })]);
    // The live Google rating is shown on the card (attributed, in memory only); no other Google text is copied.
    expect(l.rating).toBe(4.8);
    expect(l.reviewCount).toBe(120);
    for (const k of ['address', 'mapsUrl', 'reviews', 'summary', 'ratingCount']) expect(l).not.toHaveProperty(k);
    expect(JSON.stringify(l)).not.toMatch(/Mall Rd|maps\.google|Cosy/);
  });

  it('keeps the fallback title and an empty photo list on a miss, or when Google has no photos', async () => {
    const miss = make({ getDetails: async () => null });
    const [a] = await settle(miss.svc.hydrateListings([stub(1)], { hydrate: true }));
    expect(a).toMatchObject({ title: 'Homestay in Manali', titleIsFallback: true, photos: [] });
    const noPhoto = make({ getDetails: async () => details('Pine Cottage', 0) });
    const [b] = (await settle(noPhoto.svc.hydrateListings([stub(1)], { hydrate: true }))) as any[];
    expect(b.title).toBe('Pine Cottage');
    expect(b.photos).toEqual([]);
  });

  it('hydrate=false does no Google work but still strips placeId', async () => {
    const { svc, places, usage } = make();
    const out = (await svc.hydrateListings([stub(1), stub(2)], { hydrate: false })) as any[];
    expect(places.getDetails).not.toHaveBeenCalled();
    expect(usage.remaining).not.toHaveBeenCalled();
    expect(out.every((l) => !('placeId' in l))).toBe(true);
    expect(out[0].title).toBe('Homestay in Manali');
  });

  it('never mutates its input (which may be a cached object) and strips placeId from the output', async () => {
    const { svc } = make();
    const input = [stub(1), stub(2), { id: 'owner-1', verified: true, title: 'Owner place' }] as any[];
    for (const l of input) { Object.freeze(l); if (l.photos) Object.freeze(l.photos); }
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = (await settle(svc.hydrateListings(input as any, { hydrate: true }))) as any[];
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
    expect(input[0].placeId).toBe('place-1-xxxxxxxx');
    expect(out[0]).not.toBe(input[0]);
    expect(out.every((l) => !('placeId' in l))).toBe(true);
    expect(out[2]).toMatchObject({ id: 'owner-1', title: 'Owner place' });
  });

  it('never throws, even if the details lookup explodes', async () => {
    const { svc, usage } = make();
    usage.remaining.mockRejectedValue(new Error('db down'));
    const out = await settle(svc.hydrateListings([stub(1)], { hydrate: true }));
    expect(out).toHaveLength(1);
    expect(out[0].titleIsFallback).toBe(true);
  });

  it('is safe on empty and undefined input', async () => {
    const { svc } = make();
    await expect(svc.hydrateListings([], { hydrate: true })).resolves.toEqual([]);
    await expect(svc.hydrateListings(undefined as any, { hydrate: true })).resolves.toEqual([]);
  });
});
