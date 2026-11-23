import { setLockBackends } from '../common/leader-lock';
import { DiscoveryRunnerService } from './discovery-runner.service';
import { FakeDs, fakeUsage, makeClient } from './discovery.test-utils';

beforeAll(() => setLockBackends([{ acquire: async () => async () => undefined }]));
afterAll(() => setLockBackends(undefined));

const setup = (env: Record<string, string>, usage = fakeUsage()) => {
  const ds = new FakeDs();
  const { client } = makeClient(env, usage);
  return { ds, usage, runner: new DiscoveryRunnerService(ds as any, client) };
};

describe('DiscoveryRunnerService', () => {
  it('acceptance: imports 15 unique Place IDs within quota and a rerun adds 0', async () => {
    const { ds, runner, usage } = setup({ GOOGLE_PLACES_DRY_RUN: 'true' });
    ds.addJob();
    await runner.run('job-1');
    expect(ds.jobs.get('job-1')).toMatchObject({ status: 'done', new_count: 15, duplicate_count: 0, requests_used: 2 });
    expect(new Set(ds.listings.map((l) => l.external_place_id)).size).toBe(15);
    expect(ds.listings.every((l) => l.discovery_source === 'google_places_dryrun' && l.status === 'discovered')).toBe(true);
    expect(usage.count).toBe(2);

    ds.addJob({ id: 'job-2' });
    await runner.run('job-2');
    expect(ds.jobs.get('job-2')).toMatchObject({ status: 'done', new_count: 0, duplicate_count: 15 });
    expect(ds.listings).toHaveLength(15);
  });

  it('stores only Place ID, coordinates and operational fields (no Google content)', async () => {
    const { ds, runner } = setup({ GOOGLE_PLACES_DRY_RUN: 'true' });
    ds.addJob();
    await runner.run('job-1');
    expect(Object.keys(ds.listings[0].draft_data.discovery).sort()).toEqual(['destination', 'discoveredAt', 'hasPhone', 'lat', 'lng', 'placeId', 'source']);
  });

  it('skips places Google lists without a phone number and stores no number', async () => {
    const ds = new FakeDs();
    const ok = (id: string, phone?: string) => ({ id, location: { latitude: 32.24, longitude: 77.18 }, types: ['lodging'], ...(phone ? { nationalPhoneNumber: phone } : {}) });
    const fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ places: [ok('with-phone-1', '098160 11111'), ok('no-phone-1'), ok('with-phone-2', '098160 22222')] }), text: async () => '' }) as any);
    const { client } = makeClient({ GOOGLE_PLACES_API_KEY: 'k' }, fakeUsage(), { fetch });
    const runner = new DiscoveryRunnerService(ds as any, client);
    ds.addJob();
    await runner.run('job-1');
    expect(ds.listings.map((l) => l.external_place_id).sort()).toEqual(['with-phone-1', 'with-phone-2']);
    expect(JSON.stringify(ds.listings)).not.toMatch(/98160/);
    expect(ds.listings.every((l) => l.draft_data.discovery.hasPhone === true)).toBe(true);
  });

  it('fails cleanly and creates nothing when GOOGLE_PLACES_API_KEY is missing', async () => {
    const { ds, runner } = setup({});
    ds.addJob();
    await runner.run('job-1');
    expect(ds.jobs.get('job-1')).toMatchObject({ status: 'failed', error: 'blocked: GOOGLE_PLACES_API_KEY not configured' });
    expect(ds.listings).toHaveLength(0);
  });

  it('pauses (resumable) when the daily budget is exhausted', async () => {
    const { ds, runner } = setup({ GOOGLE_PLACES_DRY_RUN: 'true' });
    ds.settings.daily_request_budget = 1;
    ds.addJob();
    await runner.run('job-1');
    expect(ds.jobs.get('job-1')).toMatchObject({ status: 'paused', error: 'daily request budget exhausted', new_count: 10 });
  });

  it('honours max_new', async () => {
    const { ds, runner } = setup({ GOOGLE_PLACES_DRY_RUN: 'true' });
    ds.addJob({ max_new: 4 });
    await runner.run('job-1');
    expect(ds.jobs.get('job-1')).toMatchObject({ status: 'done', new_count: 4 });
  });

  it('stops between pages when the job is paused or cancelled', async () => {
    const { ds, runner } = setup({ GOOGLE_PLACES_DRY_RUN: 'true' });
    ds.addJob();
    ds.onPageDone = (id) => { ds.jobs.get(id).status = 'cancelled'; };
    await runner.run('job-1');
    expect(ds.jobs.get('job-1')).toMatchObject({ status: 'cancelled', new_count: 10, requests_used: 1 });
  });

  it('does not touch jobs that are not queued/running', async () => {
    const { ds, runner } = setup({ GOOGLE_PLACES_DRY_RUN: 'true' });
    ds.addJob({ status: 'cancelled' });
    await runner.run('job-1');
    expect(ds.listings).toHaveLength(0);
  });

  it('flags a candidate within 40 m of an existing listing as a duplicate (but not one farther away)', async () => {
    const { ds, runner } = setup({ GOOGLE_PLACES_DRY_RUN: 'true' });
    ds.listings.push({ id: 'live-1', status: 'live', lat: 32.2396, lng: 77.1887 });
    const near = { id: 'a', lat: 32.23975, lng: 77.1887, types: ['lodging'] }; // ~17 m
    const far = { id: 'b', lat: 32.2406, lng: 77.1887, types: ['lodging'] }; // ~110 m
    await runner.insertCandidate(near, 'Manali', 'homestay');
    await runner.insertCandidate(far, 'Manali', 'homestay');
    expect(ds.listings.find((l) => l.external_place_id === 'a')!.discovery_duplicate_of).toBe('live-1');
    expect(ds.listings.find((l) => l.external_place_id === 'b')!.discovery_duplicate_of).toBeNull();
  });

  it('stores our own derived district/tehsil/lat/lng and no Google text in the INSERT params', async () => {
    const { ds, runner } = setup({ GOOGLE_PLACES_DRY_RUN: 'true' });
    ds.addJob();
    await runner.run('job-1');
    const row = ds.listings[0];
    expect(row.disc_district).toBe('Kullu');
    expect(row.disc_tehsil).toBe('Manali');
    expect(row.disc_lat).toBe(row.lat);
    expect(row.disc_lng).toBe(row.lng);
    // [source, placeId, destination, category, duplicateOf, draftJson, district, tehsil, lat, lng]
    const p: any[] = row.insertParams;
    expect(p).toHaveLength(10);
    expect(p.slice(0, 5)).toEqual([row.discovery_source, row.external_place_id, 'Manali', 'homestay', null]);
    expect(Object.keys(JSON.parse(p[5]).discovery).sort()).toEqual(['destination', 'discoveredAt', 'hasPhone', 'lat', 'lng', 'placeId', 'source']);
    expect(JSON.parse(p[5]).property_details).toBeUndefined();
    // every string param is one of our own values (ids, destination, category, derived place names, json of our keys)
    for (const v of [p[0], p[1], p[2], p[3], p[6], p[7]]) expect(typeof v).toBe('string');
    expect(typeof p[8]).toBe('number');
    expect(typeof p[9]).toBe('number');
  });

  it('stores NULL location for an unknown destination far from any alias, never an invented tehsil', async () => {
    const { ds, runner } = setup({ GOOGLE_PLACES_DRY_RUN: 'true' });
    await runner.insertCandidate({ id: 'p-unknown-1', lat: 31.1, lng: 77.17, types: ['lodging'] }, 'Atlantis', 'homestay');
    const row = ds.listings[0];
    expect(row.disc_tehsil).toBeNull();
    expect(typeof row.disc_district).toBe('string'); // nearest HP district by our own centres
  });

  it('stores all-NULL location for a point outside Himachal', async () => {
    const { ds, runner } = setup({ GOOGLE_PLACES_DRY_RUN: 'true' });
    await runner.insertCandidate({ id: 'p-delhi-0001', lat: 28.61, lng: 77.2, types: ['lodging'] }, 'Manali', 'homestay');
    const row = ds.listings[0];
    expect([row.disc_district, row.disc_tehsil, row.disc_lat, row.disc_lng]).toEqual([null, null, null, null]);
  });

  it('bumps the search cache version once per job, not per insert', async () => {
    const ds = new FakeDs();
    const { client } = makeClient({ GOOGLE_PLACES_DRY_RUN: 'true' });
    const redis = { incrementVersion: jest.fn(async () => 2) };
    const runner = new DiscoveryRunnerService(ds as any, client, undefined, redis as any);
    ds.addJob();
    await runner.run('job-1');
    expect(ds.listings.length).toBeGreaterThan(1);
    expect(redis.incrementVersion).toHaveBeenCalledTimes(1);
    expect(redis.incrementVersion).toHaveBeenCalledWith('listings:search:version');
  });
});
