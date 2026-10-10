import * as http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '../src/auth/auth.guard';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { ResponseMessageInterceptor } from '../src/common/interceptors/response-message.interceptor';
import { GeocodeController } from '../src/listings/geocode.controller';
import { GeocodeService } from '../src/listings/geocode.service';

/** A stand-in for OpenStreetMap's Nominatim that records every request it gets. */
function startNominatim(reply: (q: string, n: number, headers: http.IncomingHttpHeaders) => { status: number; body: unknown }) {
  const calls: { q: string; at: number; headers: http.IncomingHttpHeaders; path: string }[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const q = url.searchParams.get('q') ?? '';
    calls.push({ q, at: Date.now(), headers: req.headers, path: url.pathname + url.search });
    const { status, body } = reply(q, calls.length, req.headers);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise<{ url: string; calls: typeof calls; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

const hit = (lat: number, lon: number, over: Record<string, unknown> = {}) => ({ lat: String(lat), lon: String(lon), category: 'place', type: 'hamlet', addresstype: 'hamlet', ...over });

describe('GET /api/geocode', () => {
  let app: INestApplication;
  let osm: Awaited<ReturnType<typeof startNominatim>>;
  let handler: (q: string, n: number, h: http.IncomingHttpHeaders) => { status: number; body: unknown };

  async function boot(gapMs = 0) {
    const mod = await Test.createTestingModule({
      controllers: [GeocodeController],
      providers: [
        GeocodeService,
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: ConfigService, useValue: { get: (k: string) => ({ NOMINATIM_BASE_URL: osm.url, NOMINATIM_MIN_GAP_MS: String(gapMs) })[k] } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: (ctx: any) => ((ctx.switchToHttp().getRequest().user = { userId: 'u1' }), true) })
      .compile();
    app = mod.createNestApplication();
    await app.init();
  }

  beforeEach(async () => {
    handler = () => ({ status: 200, body: [] });
    osm = await startNominatim((q, n, h) => handler(q, n, h));
  });
  afterEach(async () => {
    await app?.close();
    await osm.close();
  });

  const locate = (qs: Record<string, string>) => request(app.getHttpServer()).get('/api/geocode').query(qs);

  it('finds the exact place a host described and says so', async () => {
    await boot();
    handler = () => ({ status: 200, body: [hit(32.2701, 77.1755)] });
    const res = await locate({ district: 'Kullu', tehsil: 'Manali', q: 'Vashisht village' }).expect(200);
    expect(res.body).toMatchObject({ success: true, lat: 32.2701, lng: 77.1755, precision: 'exact' });
    expect(res.body.message).toMatch(/Found it/);
    // The lookup sent the host's words together with the tehsil, district and state.
    expect(osm.calls[0].q).toBe('Vashisht village, Manali, Kullu, Himachal Pradesh, India');
    expect(osm.calls[0].path).toContain('countrycodes=in');
  });

  it('identifies itself to OpenStreetMap, as their usage policy requires', async () => {
    await boot();
    handler = () => ({ status: 200, body: [hit(32.27, 77.17)] });
    await locate({ district: 'Kullu', tehsil: 'Manali', q: 'Vashisht' }).expect(200);
    expect(osm.calls[0].headers['user-agent']).toMatch(/^Basera\//);
  });

  it('says "area" when only a region could be found, not a spot', async () => {
    await boot();
    handler = () => ({ status: 200, body: [hit(32.25, 77.2, { category: 'boundary', type: 'administrative', addresstype: 'subdistrict' })] });
    const res = await locate({ district: 'Kullu', tehsil: 'Manali', q: 'somewhere' }).expect(200);
    expect(res.body.precision).toBe('area');
    expect(res.body.message).toMatch(/not the exact spot/);
  });

  it('falls back to the tehsil when the exact words find nothing', async () => {
    await boot();
    handler = (q) => (q.startsWith('Nowhere Special') ? { status: 200, body: [] } : { status: 200, body: [hit(32.2432, 77.1892, { addresstype: 'town' })] });
    const res = await locate({ district: 'Kullu', tehsil: 'Manali', q: 'Nowhere Special' }).expect(200);
    expect(res.body).toMatchObject({ precision: 'tehsil', lat: 32.2432, lng: 77.1892 });
    expect(res.body.message).toMatch(/near Manali/);
    expect(osm.calls.map((c) => c.q)).toEqual(['Nowhere Special, Manali, Kullu, Himachal Pradesh, India', 'Manali, Kullu, Himachal Pradesh, India']);
  });

  it('with no words typed, goes straight to the tehsil', async () => {
    await boot();
    handler = () => ({ status: 200, body: [hit(31.9592, 77.1089)] });
    const res = await locate({ district: 'Kullu', tehsil: 'Kullu' }).expect(200);
    expect(res.body.precision).toBe('tehsil');
    expect(osm.calls).toHaveLength(1);
  });

  it('falls back to the centre of the district when nothing is found', async () => {
    await boot();
    const res = await locate({ district: 'Kinnaur', tehsil: 'Sangla', q: 'unknown' }).expect(200);
    expect(res.body).toMatchObject({ success: true, precision: 'district', lat: 31.5376, lng: 78.2718 });
    expect(res.body.message).toMatch(/centre of Kinnaur/);
  });

  it('still answers with a pin when OpenStreetMap is down or errors', async () => {
    await boot();
    handler = () => ({ status: 503, body: {} });
    const a = await locate({ district: 'Mandi', tehsil: 'Karsog', q: 'x' }).expect(200);
    expect(a.body).toMatchObject({ success: true, precision: 'district' });

    await osm.close();
    const b = await locate({ district: 'Mandi', tehsil: 'Karsog', q: 'y' }).expect(200);
    expect(b.body.precision).toBe('district');
    osm = await startNominatim(() => ({ status: 200, body: [] })); // so afterEach can close cleanly
  });

  it('ignores a same-named place in another state', async () => {
    await boot();
    // A "Manali" near Chandigarh-sized latitude, outside Himachal Pradesh.
    handler = (q) => (q.includes('Kullu') ? { status: 200, body: [hit(30.7333, 76.7794), hit(32.2701, 77.1755)] } : { status: 200, body: [] });
    const res = await locate({ district: 'Kullu', tehsil: 'Manali', q: 'Vashisht' }).expect(200);
    expect(res.body).toMatchObject({ lat: 32.2701, lng: 77.1755 }); // skipped the first, took the second
  });

  it('ignores a same-named place in a different district of the state', async () => {
    await boot();
    // Inside HP, but 80+ km... far beyond the district: Kangra's centre vs Shimla.
    handler = () => ({ status: 200, body: [hit(31.1048, 77.1734)] });
    const res = await locate({ district: 'Chamba', tehsil: 'Dalhousie', q: 'x' }).expect(200);
    expect(res.body.precision).toBe('district');
  });

  it('answers a repeat question from memory, without asking OpenStreetMap again', async () => {
    await boot();
    handler = () => ({ status: 200, body: [hit(32.27, 77.17)] });
    await locate({ district: 'Kullu', tehsil: 'Manali', q: 'Vashisht' }).expect(200);
    await locate({ district: 'Kullu', tehsil: 'Manali', q: 'vashisht' }).expect(200);
    expect(osm.calls).toHaveLength(1);
  });

  it('does not remember a fallback caused by an outage, so the next try can succeed', async () => {
    await boot();
    handler = () => ({ status: 500, body: {} });
    await locate({ district: 'Una', tehsil: 'Amb', q: 'z' }).expect(200);
    handler = () => ({ status: 200, body: [hit(31.7, 76.11)] });
    const res = await locate({ district: 'Una', tehsil: 'Amb', q: 'z' }).expect(200);
    expect(res.body.precision).toBe('exact');
  });

  it('keeps to one lookup per second when asked to', async () => {
    await boot(1100);
    handler = () => ({ status: 200, body: [] });
    await Promise.all([
      locate({ district: 'Kullu', tehsil: 'Manali', q: 'a' }),
      locate({ district: 'Kullu', tehsil: 'Manali', q: 'b' }),
    ]);
    const times = osm.calls.map((c) => c.at);
    expect(times.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1050);
  }, 15_000);

  it('refuses a tehsil that does not belong to the district, with a readable 400', async () => {
    await boot();
    const res = await locate({ district: 'Kullu', tehsil: 'Dharamshala' }).expect(400);
    expect(res.body).toMatchObject({ success: false, statusCode: 400, message: 'Choose a district and a tehsil that belongs to it.' });
    expect(osm.calls).toHaveLength(0);
  });

  it('refuses a missing district', async () => {
    await boot();
    await locate({ tehsil: 'Manali' }).expect(400);
    expect(osm.calls).toHaveLength(0);
  });
});
