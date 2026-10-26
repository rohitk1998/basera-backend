import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { AuthGuard } from '../src/auth/auth.guard';
import { SupabaseProvider } from '../src/auth/supabase.provider';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { ResponseMessageInterceptor } from '../src/common/interceptors/response-message.interceptor';
import { ListingEntity, UserEntity } from '../src/entities';
import { CaptureConfigService } from '../src/listings/capture-config.service';
import { HostListingsController } from '../src/listings/host-listings.controller';
import { HostListingsService } from '../src/listings/host-listings.service';
import { RedisService } from '../src/redis/redis.service';
import { VerificationService } from '../src/verification/verification.service';

const PIN = { lat: 32.219, lng: 76.3234 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-bypass-e2e-'));
const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);

describe('capture location bypass (HTTP)', () => {
  let app: INestApplication;
  let redisStore: Map<string, string>;
  let jpeg: Buffer;
  let goodVideo: Buffer;
  let shortVideo: Buffer;

  beforeAll(() => {
    const j = path.join(tmp, 'a.jpg');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1', '-frames:v', '1', j]);
    jpeg = fs.readFileSync(j);
    const g = path.join(tmp, 'good.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=20:size=160x120:rate=10', '-pix_fmt', 'yuv420p', g]);
    goodVideo = fs.readFileSync(g);
    const s = path.join(tmp, 'short.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=4:size=160x120:rate=10', '-pix_fmt', 'yuv420p', s]);
    shortVideo = fs.readFileSync(s);
  }, 60_000);

  const boot = async (bypass: boolean | undefined) => {
    redisStore = new Map();
    const moduleRef = await Test.createTestingModule({
      controllers: [HostListingsController],
      providers: [
        HostListingsService,
        ...(bypass === undefined ? [] : [{ provide: CaptureConfigService, useValue: { locationBypass: bypass } }]),
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: getRepositoryToken(ListingEntity), useValue: {} },
        { provide: getRepositoryToken(UserEntity), useValue: {} },
        { provide: getDataSourceToken(), useValue: {} },
        { provide: VerificationService, useValue: {} },
        {
          provide: RedisService,
          useValue: {
            set: async (k: string, v: string) => (redisStore.set(k, v), true),
            get: async (k: string) => redisStore.get(k) ?? null,
            del: async (k: string) => void redisStore.delete(k),
          },
        },
        {
          provide: SupabaseProvider,
          useValue: {
            client: {
              storage: {
                from: () => ({
                  upload: async (_p: string, body: any) => {
                    if (body && typeof body.on === 'function') await new Promise<void>((res) => (body.on('data', () => {}), body.on('end', () => res()), body.on('error', () => res())));
                    return { error: null };
                  },
                  getPublicUrl: (p: string) => ({ data: { publicUrl: `https://storage.test/${p}` } }),
                }),
              },
            },
          },
        },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          if (!req.headers.authorization) throw new UnauthorizedException();
          req.user = { userId: 'u1' };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  };
  afterEach(async () => app.close());

  const auth = { Authorization: 'Bearer t' };
  const photo = (opts: { captures?: unknown; pin?: Record<string, string> } = {}) => {
    let r = request(app.getHttpServer()).post('/api/host/listings/media/photos').set(auth);
    for (const [k, v] of Object.entries(opts.pin ?? { lat: String(PIN.lat), lng: String(PIN.lng) })) r = r.field(k, v);
    r = r.field('rooms', JSON.stringify(['living']));
    if (opts.captures !== null) r = r.field('captures', JSON.stringify(opts.captures ?? [{}]));
    return r.attach('files', jpeg, { filename: 'p.jpg', contentType: 'image/jpeg' });
  };
  const walk = (video: Buffer, opts: { capture?: unknown; pin?: Record<string, string>; duration?: number } = {}) => {
    let r = request(app.getHttpServer()).post('/api/host/listings/media/walkthrough').set(auth);
    for (const [k, v] of Object.entries(opts.pin ?? { lat: String(PIN.lat), lng: String(PIN.lng) })) r = r.field(k, v);
    if (opts.capture !== null) r = r.field('capture', JSON.stringify(opts.capture ?? {}));
    if (opts.duration !== undefined) r = r.field('durationSeconds', String(opts.duration));
    return r.attach('video', video, { filename: 'w.mp4', contentType: 'video/mp4' });
  };
  const stale = () => new Date(Date.now() - 3600_000).toISOString();

  describe('flag ON', () => {
    beforeEach(() => boot(true));

    it('GET capture-config returns the flag for an authenticated user, 401 otherwise', async () => {
      const res = await request(app.getHttpServer()).get('/api/host/listings/capture-config').set(auth).expect(200);
      expect(res.body).toMatchObject({ success: true, locationBypass: true });
      await request(app.getHttpServer()).get('/api/host/listings/capture-config').expect(401);
    });

    it('accepts a photo with no claim and records it bypassed at the pin', async () => {
      const res = await photo({ captures: [null] }).expect(201);
      expect(res.body.photos).toHaveLength(1);
      const receipt = JSON.parse([...redisStore.entries()].find(([k]) => k.startsWith('capture-receipt:u1:'))![1]);
      expect(receipt).toMatchObject({ kind: 'photo', lat: PIN.lat, lng: PIN.lng, accuracyM: 1, distanceFromPinM: 0, source: 'device_reported', bypassed: true });
    });

    it.each([
      ['outside Himachal', { lat: 28.6, lng: 77.2, accuracy: 10, capturedAt: new Date().toISOString() }],
      ['5 km from the pin', { lat: PIN.lat + 0.045, lng: PIN.lng, accuracy: 10, capturedAt: new Date().toISOString() }],
      ['accuracy 500 m', { lat: PIN.lat, lng: PIN.lng, accuracy: 500, capturedAt: new Date().toISOString() }],
      ['stale', { lat: PIN.lat, lng: PIN.lng, accuracy: 10, capturedAt: stale() }],
    ])('accepts a photo claimed %s', async (_n, claim) => {
      await photo({ captures: [claim] }).expect(201);
      const receipt = JSON.parse([...redisStore.entries()].find(([k]) => k.startsWith('capture-receipt:u1:'))![1]);
      expect(receipt).toMatchObject({ lat: PIN.lat, lng: PIN.lng, bypassed: true });
    });

    it('still needs the captures array and a JPEG', async () => {
      await photo({ captures: null }).expect(400);
      await request(app.getHttpServer())
        .post('/api/host/listings/media/photos').set(auth)
        .field('lat', String(PIN.lat)).field('lng', String(PIN.lng)).field('rooms', '["living"]').field('captures', '[{}]')
        .attach('files', Buffer.from('not a jpeg'), { filename: 'p.jpg', contentType: 'image/jpeg' })
        .expect(400);
    });

    it('accepts a location-less walkthrough and flags it bypassed', async () => {
      const res = await walk(goodVideo, { capture: {} }).expect(201);
      expect(res.body).toMatchObject({ passed: true, method: 'camera_captured' });
      const stored = JSON.parse([...redisStore.entries()].find(([k]) => k.startsWith('walkthrough-token:'))![1]);
      expect(stored.check).toMatchObject({ bypassed: true, capture: { kind: 'video', bypassed: true, distanceFromPinM: 0 } });
    });

    it('accepts a walkthrough claimed far away', async () => {
      const far = { lat: 28.6, lng: 77.2, accuracy: 900, capturedAt: stale() };
      await walk(goodVideo, { capture: far }).expect(201);
    });

    it('still rejects a too-short video', async () => {
      const res = await walk(shortVideo, { capture: {} }).expect(201);
      expect(res.body.passed).toBe(false);
      expect(res.body.reason).toMatch(/only \d+s long/);
    });

    it('still rejects a non-in-app upload (no capture details at all)', async () => {
      const res = await walk(goodVideo, { capture: null as any }).expect(400);
      expect(res.body.message).toMatch(/camera capture details/);
    });
  });

  describe('flag OFF or not configured', () => {
    it.each([[false], [undefined]])('behaves as before (flag %s)', async (flag) => {
      await boot(flag);
      const cfg = await request(app.getHttpServer()).get('/api/host/listings/capture-config').set(auth).expect(200);
      expect(cfg.body.locationBypass).toBe(false);
      await photo({ captures: [null] }).expect(400);
      await photo({ captures: [{ lat: 28.6, lng: 77.2, accuracy: 10, capturedAt: new Date().toISOString() }] }).expect(400);
      const w = await walk(goodVideo, { capture: {} }).expect(201);
      expect(w.body.passed).toBe(false);
    });
  });
});
