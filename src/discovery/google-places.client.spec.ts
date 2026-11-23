import { FIELD_MASK, PLACES_URL, PlacesBlockedError, PlacesBudgetExhaustedError } from './google-places.client';
import { fakeUsage, makeClient } from './discovery.test-utils';

const res = (status: number, body: unknown = {}) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as any;
const req = { textQuery: 'homestay in Manali', destination: 'Manali', budget: 100 };

describe('GooglePlacesClient', () => {
  it('is blocked (and never fetches) without GOOGLE_PLACES_API_KEY', async () => {
    const fetch = jest.fn();
    const { client } = makeClient({}, fakeUsage(), { fetch });
    expect(client.blockedReason()).toBe('blocked: GOOGLE_PLACES_API_KEY not configured');
    await expect(client.searchText(req)).rejects.toThrow(PlacesBlockedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends the minimal field mask and parses places + nextPageToken', async () => {
    const fetch = jest.fn(async () => res(200, { places: [{ id: 'p1', location: { latitude: 1, longitude: 2 }, types: ['lodging'], displayName: { text: 'X' } }, { id: 'bad' }], nextPageToken: 't2' }));
    const { client } = makeClient({ GOOGLE_PLACES_API_KEY: 'k' }, fakeUsage(), { fetch });
    const page = await client.searchText({ ...req, pageToken: 't1' });
    const [url, init] = fetch.mock.calls[0] as any;
    expect(url).toBe(PLACES_URL);
    expect(init.headers['X-Goog-FieldMask']).toBe(FIELD_MASK);
    expect(FIELD_MASK).not.toMatch(/photos|reviews|rating|formattedAddress|website/);
    // Phone fields are asked for only to learn if a number exists.
    expect(FIELD_MASK).toMatch(/nationalPhoneNumber/);
    expect(JSON.parse(init.body).pageToken).toBe('t1');
    expect(page.places).toHaveLength(1);
    expect(page.nextPageToken).toBe('t2');
  });

  it('keeps only a yes/no for the phone and never the number itself', async () => {
    const fetch = jest.fn(async () => res(200, { places: [
      { id: 'p1', location: { latitude: 1, longitude: 2 }, nationalPhoneNumber: '098160 12345' },
      { id: 'p2', location: { latitude: 1, longitude: 2 }, internationalPhoneNumber: '+91 98160 12345' },
      { id: 'p3', location: { latitude: 1, longitude: 2 } },
    ] }));
    const { client } = makeClient({ GOOGLE_PLACES_API_KEY: 'k' }, fakeUsage(), { fetch });
    const page = await client.searchText(req);
    expect(page.places.map((p) => p.hasPhone)).toEqual([true, true, false]);
    expect(JSON.stringify(page.places)).not.toMatch(/98160/);
  });

  it('retries 429/5xx with exponential backoff + jitter, counting every attempt against the budget', async () => {
    const seq = [res(429), res(503), res(200, { places: [] })];
    const fetch = jest.fn(async () => seq.shift());
    const sleep = jest.fn(async (_ms: number) => undefined);
    const usage = fakeUsage();
    const { client } = makeClient({ GOOGLE_PLACES_API_KEY: 'k' }, usage, { fetch, sleep, random: () => 0 });
    await client.searchText(req);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
    expect(usage.count).toBe(3);
    expect(client.backoffMs(2)).toBeGreaterThanOrEqual(2000);
  });

  it('gives up after repeated 5xx', async () => {
    const { client } = makeClient({ GOOGLE_PLACES_API_KEY: 'k' }, fakeUsage(), { fetch: async () => res(500), sleep: async () => undefined });
    await expect(client.searchText(req)).rejects.toThrow(/HTTP 500 after 5 attempts/);
  });

  it('opens the circuit breaker on 403 and refuses further calls', async () => {
    const fetch = jest.fn(async () => res(403, { error: { status: 'PERMISSION_DENIED' } }));
    const { client } = makeClient({ GOOGLE_PLACES_API_KEY: 'k' }, fakeUsage(), { fetch });
    await expect(client.searchText(req)).rejects.toThrow(PlacesBlockedError);
    await expect(client.searchText(req)).rejects.toThrow(/circuit breaker/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('enforces the hard daily budget before the request is made', async () => {
    const fetch = jest.fn(async () => res(200, { places: [] }));
    const { client } = makeClient({ GOOGLE_PLACES_API_KEY: 'k' }, fakeUsage(), { fetch });
    await client.searchText({ ...req, budget: 1 });
    await expect(client.searchText({ ...req, budget: 1 })).rejects.toThrow(PlacesBudgetExhaustedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('dry run paginates deterministically: 15 results over 2 pages, tagged google_places_dryrun', async () => {
    const { client } = makeClient({ GOOGLE_PLACES_DRY_RUN: 'true' });
    expect(client.sourceKey).toBe('google_places_dryrun');
    const p1 = await client.searchText(req);
    expect(p1.places).toHaveLength(10);
    expect(p1.nextPageToken).toBeDefined();
    const p2 = await client.searchText({ ...req, pageToken: p1.nextPageToken });
    expect(p2.places).toHaveLength(5);
    expect(p2.nextPageToken).toBeUndefined();
    const ids = [...p1.places, ...p2.places].map((p) => p.id);
    expect(new Set(ids).size).toBe(15);
    expect((await client.searchText(req)).places.map((p) => p.id)).toEqual(p1.places.map((p) => p.id));
  });
});
