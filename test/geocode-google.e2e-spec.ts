import * as http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '../src/auth/auth.guard';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { ResponseMessageInterceptor } from '../src/common/interceptors/response-message.interceptor';
import { GeocodeController } from '../src/listings/geocode.controller';
import { GeocodeService } from '../src/listings/geocode.service';

type Reply = { status: number; body: unknown };
type Call = { params: URLSearchParams; path: string; at: number; ua?: string };

/** A real HTTP stand-in that records every request (used for both Google and Nominatim). */
function startServer(reply: (c: Call, n: number) => Reply) {
  const calls: Call[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    calls.push({ params: url.searchParams, path: url.pathname, at: Date.now(), ua: req.headers['user-agent'] });
    const { status, body } = reply(calls[calls.length - 1], calls.length);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise<{ url: string; calls: Call[]; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

const KEY = 'test-google-key-7f3a91';
const osmHit = (lat: number, lon: number, over: Record<string, unknown> = {}) => ({ lat: String(lat), lon: String(lon), category: 'place', type: 'hamlet', addresstype: 'hamlet', ...over });
const gHit = (lat: number, lng: number, locationType: string, types: string[]) => ({
  formatted_address: 'somewhere',
  types,
  geometry: { location: { lat, lng }, location_type: locationType },
});
const ok = (...results: unknown[]): Reply => ({ status: 200, body: { status: 'OK', results } });
const zero: Reply = { status: 200, body: { status: 'ZERO_RESULTS', results: [] } };
const gStatus = (status: string): Reply => ({ status: 200, body: { status, results: [], error_message: `bad things: key=${KEY}` } });

describe('GET /api/geocode with Google as the primary provider', () => {
  let app: INestApplication;
  let google: Awaited<ReturnType<typeof startServer>>;
  let osm: Awaited<ReturnType<typeof startServer>>;
  let gReply: (c: Call, n: number) => Reply;
  let oReply: (c: Call, n: number) => Reply;
  let logged: string[];
  const spies: jest.SpyInstance[] = [];

  async function boot(opts: { key?: string | null } = {}) {
    const cfg: Record<string, string | undefined> = {
      NOMINATIM_BASE_URL: osm.url,
      NOMINATIM_MIN_GAP_MS: '0',
      GOOGLE_GEOCODE_BASE_URL: google.url,
      GOOGLE_MAPS_SERVER_KEY: opts.key === null ? undefined : (opts.key ?? KEY),
    };
    const mod = await Test.createTestingModule({
      controllers: [GeocodeController],
      providers: [
        GeocodeService,
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: ConfigService, useValue: { get: (k: string) => cfg[k] } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: (ctx: any) => ((ctx.switchToHttp().getRequest().user = { userId: 'u1' }), true) })
      .compile();
    app = mod.createNestApplication();
    await app.init();
  }

  beforeEach(async () => {
    gReply = () => zero;
    oReply = () => ({ status: 200, body: [] });
    google = await startServer((c, n) => gReply(c, n));
    osm = await startServer((c, n) => oReply(c, n));
    logged = [];
    for (const m of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      spies.push(jest.spyOn(Logger.prototype, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' '))));
    }
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    spies.length = 0;
    await app?.close();
    await google.close().catch(() => undefined);
    await osm.close().catch(() => undefined);
  });

  const locate = (qs: Record<string, string>) => request(app.getHttpServer()).get('/api/geocode').query(qs);
  const reverse = (qs: Record<string, string>) => request(app.getHttpServer()).get('/api/geocode/reverse').query(qs);
  const VASHISHT = { district: 'Kullu', tehsil: 'Manali', q: 'Vashisht village' };

  it('uses a Google rooftop hit as the exact answer, sending the key and the Himachal restriction', async () => {
    await boot();
    gReply = () => ok(gHit(32.2701, 77.1755, 'ROOFTOP', ['premise']));
    const res = await locate(VASHISHT).expect(200);
    expect(res.body).toMatchObject({ success: true, lat: 32.2701, lng: 77.1755, precision: 'exact', source: 'google' });
    expect(res.body.message).toMatch(/Found it/);
    expect(osm.calls).toHaveLength(0);
    expect(google.calls).toHaveLength(1);
    expect(google.calls[0].path).toBe('/maps/api/geocode/json');
    expect(google.calls[0].params.get('address')).toBe('Vashisht village, Manali, Kullu, Himachal Pradesh, India');
    expect(google.calls[0].params.get('components')).toBe('country:IN|administrative_area:Himachal Pradesh');
    expect(google.calls[0].params.get('key')).toBe(KEY);
  });

  it.each([
    ['RANGE_INTERPOLATED', ['street_address'], 'exact'],
    ['GEOMETRIC_CENTER', ['point_of_interest', 'establishment'], 'exact'],
    ['GEOMETRIC_CENTER', ['sublocality', 'political'], 'exact'],
    ['GEOMETRIC_CENTER', ['locality', 'political'], 'area'],
    ['APPROXIMATE', ['route'], 'area'],
    ['ROOFTOP', ['administrative_area_level_2', 'political'], 'area'],
  ])('maps %s with types %j to precision %s', async (locationType, types, precision) => {
    await boot();
    gReply = () => ok(gHit(32.2701, 77.1755, locationType, types));
    const res = await locate(VASHISHT).expect(200);
    expect(res.body).toMatchObject({ precision, source: 'google' });
    if (precision === 'area') expect(res.body.message).toMatch(/not the exact spot/);
  });

  it('reports an approximate Google hit as an area', async () => {
    await boot();
    gReply = () => ok(gHit(32.25, 77.2, 'APPROXIMATE', ['locality', 'political']));
    const res = await locate(VASHISHT).expect(200);
    expect(res.body).toMatchObject({ precision: 'area', source: 'google', lat: 32.25, lng: 77.2 });
  });

  it('falls through to Nominatim when Google finds nothing', async () => {
    await boot();
    oReply = () => ({ status: 200, body: [osmHit(32.2701, 77.1755)] });
    const res = await locate(VASHISHT).expect(200);
    expect(res.body).toMatchObject({ precision: 'exact', source: 'osm', lat: 32.2701 });
    expect(google.calls).toHaveLength(1);
    expect(osm.calls).toHaveLength(1);
  });

  it.each(['REQUEST_DENIED', 'OVER_QUERY_LIMIT', 'OVER_DAILY_LIMIT'])(
    '%s falls back to Nominatim and pauses Google for the next requests',
    async (status) => {
      await boot();
      gReply = () => gStatus(status);
      oReply = () => ({ status: 200, body: [osmHit(32.2701, 77.1755)] });
      const a = await locate(VASHISHT).expect(200);
      expect(a.body).toMatchObject({ source: 'osm', precision: 'exact' });
      const after = google.calls.length;
      expect(after).toBe(1); // the second (tehsil) step of the same request did not retry Google either

      const b = await locate({ district: 'Kullu', tehsil: 'Manali', q: 'Old Manali' }).expect(200);
      expect(b.body).toMatchObject({ source: 'osm' });
      const c = await locate({ district: 'Mandi', tehsil: 'Karsog', q: 'whatever' });
      expect(c.status).toBe(200);
      expect(google.calls).toHaveLength(after); // breaker open: Google not called again
      expect(osm.calls.length).toBeGreaterThanOrEqual(2);
    },
  );

  it('asks Google again once the 5 minute pause is over', async () => {
    await boot();
    gReply = () => gStatus('OVER_QUERY_LIMIT');
    oReply = () => ({ status: 200, body: [osmHit(32.2701, 77.1755)] });
    await locate(VASHISHT).expect(200);
    expect(google.calls).toHaveLength(1);

    const later = Date.now() + 5 * 60 * 1000 + 1000;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    gReply = () => ok(gHit(32.2701, 77.1755, 'ROOFTOP', ['premise']));
    const res = await locate({ district: 'Kullu', tehsil: 'Manali', q: 'Another place' }).expect(200);
    expect(res.body.source).toBe('google');
    expect(google.calls).toHaveLength(2);
  });

  it.each(['INVALID_REQUEST', 'UNKNOWN_ERROR'])('%s falls back to Nominatim without pausing Google', async (status) => {
    await boot();
    gReply = () => gStatus(status);
    oReply = () => ({ status: 200, body: [osmHit(32.2701, 77.1755)] });
    await locate(VASHISHT).expect(200);
    gReply = () => ok(gHit(32.2701, 77.1755, 'ROOFTOP', ['premise']));
    const res = await locate({ district: 'Kullu', tehsil: 'Manali', q: 'Other' }).expect(200);
    expect(res.body.source).toBe('google');
  });

  it('falls back to Nominatim on an HTTP 500 from Google', async () => {
    await boot();
    gReply = () => ({ status: 500, body: {} });
    oReply = () => ({ status: 200, body: [osmHit(32.2701, 77.1755)] });
    const res = await locate(VASHISHT).expect(200);
    expect(res.body).toMatchObject({ source: 'osm', precision: 'exact' });
  });

  it('falls back to Nominatim when Google cannot be reached at all', async () => {
    await boot();
    await google.close();
    oReply = () => ({ status: 200, body: [osmHit(32.2701, 77.1755)] });
    const res = await locate(VASHISHT).expect(200);
    expect(res.body).toMatchObject({ source: 'osm', precision: 'exact' });
    expect(logged.some((l) => /Google geocoding unavailable/.test(l))).toBe(true);
    google = await startServer(() => zero); // so afterEach can close cleanly
  });

  it('skips a Google result outside Himachal Pradesh and takes the next one', async () => {
    await boot();
    gReply = () => ok(gHit(30.7333, 76.7794, 'ROOFTOP', ['premise']), gHit(32.2701, 77.1755, 'ROOFTOP', ['premise']));
    const res = await locate(VASHISHT).expect(200);
    expect(res.body).toMatchObject({ source: 'google', lat: 32.2701, lng: 77.1755 });
  });

  it('skips a Google result in the state but far from the district, then uses Nominatim', async () => {
    await boot();
    gReply = () => ok(gHit(31.1048, 77.1734, 'ROOFTOP', ['premise'])); // Shimla, for a Chamba lookup
    oReply = () => ({ status: 200, body: [osmHit(32.5534, 76.1258)] });
    const res = await locate({ district: 'Chamba', tehsil: 'Dalhousie', q: 'x' }).expect(200);
    expect(res.body).toMatchObject({ source: 'osm', lat: 32.5534 });
  });

  it('uses the tehsil step, reported as "tehsil", when the exact words find nothing', async () => {
    await boot();
    gReply = (c) =>
      c.params.get('address')!.startsWith('Nowhere Special') ? zero : ok(gHit(32.2432, 77.1892, 'APPROXIMATE', ['locality', 'political']));
    const res = await locate({ district: 'Kullu', tehsil: 'Manali', q: 'Nowhere Special' }).expect(200);
    expect(res.body).toMatchObject({ precision: 'tehsil', source: 'google', lat: 32.2432, lng: 77.1892 });
    expect(res.body.message).toMatch(/near Manali/);
    expect(google.calls.map((c) => c.params.get('address'))).toEqual([
      'Nowhere Special, Manali, Kullu, Himachal Pradesh, India',
      'Manali, Kullu, Himachal Pradesh, India',
    ]);
    expect(osm.calls.filter((c) => c.path === '/search')).toHaveLength(1); // only the exact-words step fell through to OSM
  });

  it('with no words typed, goes straight to the tehsil on Google', async () => {
    await boot();
    gReply = () => ok(gHit(31.9592, 77.1089, 'GEOMETRIC_CENTER', ['locality', 'political']));
    const res = await locate({ district: 'Kullu', tehsil: 'Kullu' }).expect(200);
    expect(res.body).toMatchObject({ precision: 'tehsil', source: 'google' });
    expect(google.calls).toHaveLength(1);
  });

  it('answers with the district centre, source "fallback", and 200 when both providers are down', async () => {
    await boot();
    gReply = () => ({ status: 500, body: {} });
    oReply = () => ({ status: 503, body: {} });
    const res = await locate({ district: 'Kinnaur', tehsil: 'Sangla', q: 'unknown' }).expect(200);
    expect(res.body).toMatchObject({ success: true, precision: 'district', source: 'fallback', lat: 31.5376, lng: 78.2718 });
    expect(res.body.message).toMatch(/centre of Kinnaur/);

    // The fallback is not remembered: once a provider is back, the next try succeeds.
    gReply = () => ok(gHit(31.42, 78.26, 'ROOFTOP', ['premise']));
    const again = await locate({ district: 'Kinnaur', tehsil: 'Sangla', q: 'unknown' }).expect(200);
    expect(again.body.source).toBe('google');
  });

  it('never lets the key reach a log line or a response body', async () => {
    await boot();
    gReply = () => gStatus('REQUEST_DENIED'); // Google even echoes the key in its error text
    const a = await locate(VASHISHT).expect(200);
    await google.close();
    google = await startServer(() => ({ status: 500, body: {} }));
    const b = await locate({ district: 'Mandi', tehsil: 'Karsog', q: 'x' }).expect(200);
    const r = await reverse({ lat: '32.27', lng: '77.17' }).expect(200);
    expect(JSON.stringify([a.body, b.body, r.body])).not.toContain(KEY);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join('\n')).not.toContain(KEY);
  });

  it('never calls Google when no key is configured', async () => {
    await boot({ key: null });
    oReply = () => ({ status: 200, body: [osmHit(32.2701, 77.1755)] });
    const res = await locate(VASHISHT).expect(200);
    expect(res.body).toMatchObject({ source: 'osm', precision: 'exact' });
    await reverse({ lat: '32.27', lng: '77.17' }).expect(200);
    expect(google.calls).toHaveLength(0);
  });

  it('treats a blank key as not configured', async () => {
    await boot({ key: '  ' });
    await locate(VASHISHT).expect(200);
    expect(google.calls).toHaveLength(0);
  });

  it('answers a repeat question from memory, with no provider call at all', async () => {
    await boot();
    gReply = () => ok(gHit(32.2701, 77.1755, 'ROOFTOP', ['premise']));
    await locate(VASHISHT).expect(200);
    const res = await locate({ ...VASHISHT, q: 'vashisht VILLAGE' }).expect(200);
    expect(res.body.source).toBe('google');
    expect(google.calls).toHaveLength(1);
    expect(osm.calls).toHaveLength(0);
  });

  describe('GET /api/geocode/reverse', () => {
    it('reads the address from Google first', async () => {
      await boot();
      gReply = () => ok({ formatted_address: 'Vashisht Rd, Manali, Himachal Pradesh 175131, India' });
      const res = await reverse({ lat: '32.2701', lng: '77.1755' }).expect(200);
      expect(res.body).toEqual({
        success: true,
        address: 'Vashisht Rd, Manali, Himachal Pradesh 175131, India',
        parts: { street: 'Vashisht Rd, Manali' },
        source: 'google',
      });
      expect(google.calls[0].params.get('latlng')).toBe('32.2701,77.1755');
      expect(google.calls[0].params.get('key')).toBe(KEY);
      expect(osm.calls).toHaveLength(0);
    });

    it('falls back to Nominatim when Google fails, identifying itself', async () => {
      await boot();
      gReply = () => gStatus('OVER_QUERY_LIMIT');
      oReply = () => ({ status: 200, body: { display_name: 'Old Manali, Kullu, Himachal Pradesh, India' } });
      const res = await reverse({ lat: '32.2701', lng: '77.1755' }).expect(200);
      expect(res.body).toEqual({
        success: true,
        address: 'Old Manali, Kullu, Himachal Pradesh, India',
        parts: { street: 'Old Manali, Kullu' },
        source: 'osm',
      });
      expect(osm.calls[0].params.get('addressdetails')).toBe('1');
      expect(osm.calls[0].path).toBe('/reverse');
      expect(osm.calls[0].ua).toMatch(/^Basera\//);
      expect(osm.calls[0].params.get('format')).toBe('jsonv2');
      expect(osm.calls[0].params.get('lat')).toBe('32.2701');
      expect(osm.calls[0].params.get('lon')).toBe('77.1755');
      expect(osm.calls[0].params.get('zoom')).toBe('18');
    });

    it('falls back to Nominatim when Google has no result', async () => {
      await boot();
      oReply = () => ({ status: 200, body: { display_name: 'Somewhere, Kullu' } });
      const res = await reverse({ lat: '32.2701', lng: '77.1755' }).expect(200);
      expect(res.body).toMatchObject({ address: 'Somewhere, Kullu', source: 'osm' });
    });

    it('splits the address into the form fields: district, tehsil, city, area, PIN (the Ghumarwin pin)', async () => {
      await boot();
      const c = (long_name: string, ...types: string[]) => ({ long_name, short_name: long_name, types });
      gReply = () =>
        ok({
          formatted_address: 'NH103, Sohal, Ghumarwin, Himachal Pradesh 174021, India',
          address_components: [
            c('NH103', 'route'),
            c('Sohal', 'sublocality_level_1', 'sublocality'),
            c('Ghumarwin', 'locality'),
            c('Ghumarwin', 'administrative_area_level_3'),
            c('Bilaspur', 'administrative_area_level_2'),
            c('Himachal Pradesh', 'administrative_area_level_1'),
            c('India', 'country'),
            c('174021', 'postal_code'),
          ],
        });
      const res = await reverse({ lat: '31.4618', lng: '76.6910' }).expect(200);
      expect(res.body.parts).toEqual({
        district: 'Bilaspur',
        tehsil: 'Ghumarwin',
        city: 'Ghumarwin',
        locality: 'Sohal',
        pincode: '174021',
        street: 'NH103, Sohal, Ghumarwin',
      });
    });

    it('does the same from OpenStreetMap when Google is unavailable', async () => {
      await boot();
      gReply = () => gStatus('REQUEST_DENIED');
      oReply = () => ({
        status: 200,
        body: {
          display_name: 'Sohal, Ghumarwin, Bilaspur, Himachal Pradesh, 174021, India',
          address: { village: 'Sohal', county: 'Ghumarwin Tehsil', state_district: 'Bilaspur', postcode: '174021' },
        },
      });
      const res = await reverse({ lat: '31.4618', lng: '76.6910' }).expect(200);
      expect(res.body.source).toBe('osm');
      expect(res.body.parts).toMatchObject({ district: 'Bilaspur', tehsil: 'Ghumarwin', city: 'Sohal', pincode: '174021' });
    });

    it('answers 200 with an empty address when both providers fail', async () => {
      await boot();
      gReply = () => ({ status: 500, body: {} });
      oReply = () => ({ status: 200, body: { error: 'Unable to geocode' } });
      const res = await reverse({ lat: '32.2701', lng: '77.1755' }).expect(200);
      expect(res.body).toEqual({ success: true, address: '', parts: {}, source: 'none' });
    });

    it('does not remember a failure, but remembers a success (4-decimal key)', async () => {
      await boot();
      gReply = () => ({ status: 500, body: {} });
      await reverse({ lat: '32.2701', lng: '77.1755' }).expect(200);
      gReply = () => ok({ formatted_address: 'Found now' });
      const a = await reverse({ lat: '32.2701', lng: '77.1755' }).expect(200);
      expect(a.body.address).toBe('Found now');
      const before = google.calls.length;
      const b = await reverse({ lat: '32.270149', lng: '77.175501' }).expect(200); // rounds to the same 4 decimals
      expect(b.body.address).toBe('Found now');
      expect(google.calls).toHaveLength(before);
    });

    it.each([
      [{ lat: '30.7333', lng: '76.7794' }],
      [{ lat: '28.6', lng: '77.2' }],
      [{ lat: 'abc', lng: '77.17' }],
      [{ lat: '32.27' }],
      [{}],
    ])('refuses %j with a readable 400 and no provider call', async (qs) => {
      await boot();
      const res = await reverse(qs as Record<string, string>).expect(400);
      expect(res.body).toMatchObject({ success: false, statusCode: 400, message: 'That spot is outside Himachal Pradesh.' });
      expect(google.calls).toHaveLength(0);
      expect(osm.calls).toHaveLength(0);
    });

    it('sits behind the same AuthGuard as the forward lookup and is throttled', () => {
      const guards = Reflect.getMetadata('__guards__', GeocodeController) as unknown[];
      expect(guards).toContain(AuthGuard);
      const proto = GeocodeController.prototype;
      expect(Reflect.getMetadata('path', proto.reverse)).toBe('reverse');
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto.reverse)).toBeGreaterThan(0);
    });
  });
});
