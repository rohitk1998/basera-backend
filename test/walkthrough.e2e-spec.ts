import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { exiftool } from 'exiftool-vendored';
import { AuthGuard } from '../src/auth/auth.guard';
import { SupabaseProvider } from '../src/auth/supabase.provider';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { ResponseMessageInterceptor } from '../src/common/interceptors/response-message.interceptor';
import { ListingEntity, UserEntity } from '../src/entities';
import { HostListingsController } from '../src/listings/host-listings.controller';
import { HostListingsService } from '../src/listings/host-listings.service';
import { RedisService } from '../src/redis/redis.service';
import { VerificationService } from '../src/verification/verification.service';

const PIN = { lat: 32.219, lng: 76.3234 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-e2e-'));

function makeVideo(name: string, opts: { seconds: number; extra?: string[] }) {
  const file = path.join(tmp, name);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=duration=${opts.seconds}:size=160x120:rate=10`, '-pix_fmt', 'yuv420p', ...(opts.extra ?? []), file]);
  return file;
}

function makeLiveWebm(name: string, seconds: number) {
  const file = path.join(tmp, name);
  const out = execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=160x120:rate=10`, '-c:v', 'libvpx', '-f', 'webm', '-live', '1', 'pipe:1'], { maxBuffer: 50 * 1024 * 1024 });
  fs.writeFileSync(file, out);
  return file;
}

function makeAudioOnly(name: string, seconds: number) {
  const file = path.join(tmp, name);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=duration=${seconds}`, '-c:a', 'aac', file]);
  return file;
}

const capture = (over: Record<string, unknown> = {}) => ({
  lat: PIN.lat + 0.0003,
  lng: PIN.lng,
  accuracy: 12,
  capturedAt: new Date().toISOString(),
  ...over,
});

describe('POST /api/host/listings/media/walkthrough', () => {
  let app: INestApplication;
  let redisWrites: { key: string; value: string }[];
  let uploads: string[];
  let uploadedBuffers: Record<string, Buffer>;
  let redisFailures: number;
  let storageBehaviour: 'ok' | 'error' | 'throws' | 'slow';
  const files: Record<string, string> = {};

  beforeAll(async () => {
    files.good = makeVideo('good.mp4', { seconds: 20 });
    files.live = makeLiveWebm('live.webm', 20);
    files.liveShort = makeLiveWebm('live-short.webm', 5);
    files.short = makeVideo('short.mp4', { seconds: 4 });
    files.audioOnly = makeAudioOnly('audio.mp4', 20);
    files.future = makeVideo('future.mp4', { seconds: 20, extra: ['-metadata', 'creation_time=2099-01-01T00:00:00Z'] });
  }, 60_000);

  beforeEach(async () => {
    redisWrites = [];
    redisFailures = 0;
    uploads = [];
    uploadedBuffers = {};
    storageBehaviour = 'ok';

    const moduleRef = await Test.createTestingModule({
      controllers: [HostListingsController],
      providers: [
        HostListingsService,
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: getRepositoryToken(ListingEntity), useValue: {} },
        { provide: getRepositoryToken(UserEntity), useValue: {} },
        { provide: getDataSourceToken(), useValue: {} },
        { provide: VerificationService, useValue: {} },
        { provide: RedisService, useValue: {
            set: async (key: string, value: string) => {
              if (redisFailures > 0) {
                redisFailures--;
                return false;
              }
              redisWrites.push({ key, value });
              return true;
            },
            get: async (key: string) => redisWrites.find((w) => w.key === key)?.value ?? null,
            del: async () => {},
          },
        },
        {
          provide: SupabaseProvider,
          useValue: {
            client: {
              storage: {
                from: () => ({
                  upload: async (p: string, stream: NodeJS.ReadableStream | Buffer) => {
                    if (Buffer.isBuffer(stream)) {
                      uploadedBuffers[p] = stream;
                      uploads.push(p);
                      return { error: null };
                    }
                    if (storageBehaviour === 'throws') throw new Error('storage exploded');
                    if (storageBehaviour === 'slow') await new Promise((r) => setTimeout(r, 4000));
                    await new Promise<void>((res, rej) => (stream.on('data', () => {}), stream.on('end', () => res()), stream.on('error', rej)));
                    if (storageBehaviour === 'error') return { error: { message: 'bucket unavailable' } };
                    uploads.push(p);
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
      .useValue({ canActivate: (ctx: any) => ((ctx.switchToHttp().getRequest().user = { userId: 'u1' }), true) })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterEach(async () => app.close());

  const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

  const check = (
    file: string | null,
    opts: { pin?: Record<string, string>; capture?: unknown; duration?: number } = {},
    type = 'video/mp4',
  ) => {
    const fields: Record<string, string> = {
      ...(opts.pin ?? { lat: String(PIN.lat), lng: String(PIN.lng) }),
      ...(opts.capture === null ? {} : { capture: JSON.stringify(opts.capture ?? capture()) }),
      ...(opts.duration !== undefined ? { durationSeconds: String(opts.duration) } : {}),
    };
    let r = request(app.getHttpServer()).post('/api/host/listings/media/walkthrough');
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    if (file) r = r.attach('video', fs.readFileSync(file), { filename: path.basename(file), contentType: type });
    return r;
  };

  it('passes a camera capture at the pin, stores the one-time token with the capture, and keeps the video', async () => {
    const res = await check(files.good).expect(201);
    expect(res.body).toMatchObject({
      success: true,
      message: 'Video recorded near the pin (location reported by your device). Our team will review it.',
      passed: true,
      method: 'camera_captured',
      needsVisualReview: true,
    });
    expect(res.body.walkthroughToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.walkthroughVideoUrl).toMatch(/^https:\/\/storage\.test\/u1\/walkthrough\/.+\.mp4$/);
    expect(res.body.durationSeconds).toBeCloseTo(20, 0);
    expect(res.body.distanceMetres).toBeLessThan(60);

    expect(redisWrites).toHaveLength(1);
    expect(JSON.parse(redisWrites[0].value)).toMatchObject(PIN);
    expect(redisWrites[0].key).toContain(res.body.walkthroughToken);
    await settle();
    expect(uploads).toHaveLength(1);
  });

  it('records the capture as device-reported and never as verified', async () => {
    const res = await check(files.good).expect(201);
    expect(res.body.warnings.join(' ')).not.toMatch(/recording date|camera make/);
    const stored = JSON.parse(redisWrites[0].value);
    expect(stored.check).toMatchObject({
      method: 'camera_captured',
      visuallyVerified: false,
      capture: { kind: 'video', source: 'device_reported', accuracyM: 12 },
    });
    expect(stored.check.capture.distanceFromPinM).toBeLessThan(60);
    expect(stored.videoUrl).toBe(res.body.walkthroughVideoUrl);
    await settle();
  });

  it('accepts a MediaRecorder-style WebM with no length in its header, using the length the browser measured', async () => {
    const res = await check(files.live, { duration: 20.4 }, 'video/webm;codecs=vp8').expect(201);
    expect(res.body).toMatchObject({ passed: true, method: 'camera_captured', durationSeconds: 20.4 });
    expect(res.body.walkthroughVideoUrl).toMatch(/\.webm$/);
    expect(res.body.warnings.join(' ')).toMatch(/length was reported by the browser/);
    expect(JSON.parse(redisWrites[0].value).check).toMatchObject({ durationSource: 'client_reported' });
    await settle();
  });

  it('refuses a length-less WebM when the browser did not report one, and when the reported length is too short', async () => {
    const none = await check(files.live, {}, 'video/webm').expect(201);
    expect(none.body).toMatchObject({ passed: false });
    expect(none.body.message).toMatch(/length/);
    const short = await check(files.liveShort, { duration: 5 }, 'video/webm').expect(201);
    expect(short.body).toMatchObject({ passed: false });
    expect(short.body.message).toMatch(/only 5s long/);
    expect(redisWrites).toHaveLength(0);
  });

  it('refuses a capture with no capture details at all', async () => {
    const res = await check(files.good, { capture: null }).expect(400);
    expect(res.body.message).toMatch(/no camera capture details/);
    expect(redisWrites).toHaveLength(0);
  });

  it.each([
    ['another town', { lat: 32.2396, lng: 77.1887 }, /captured .* from the pin/],
    ['outside Himachal Pradesh', { lat: 28.6139, lng: 77.209 }, /outside Himachal Pradesh/],
    ['a poor location fix', { accuracy: 450 }, /only to within 450 m/],
    ['a future timestamp', { capturedAt: new Date(Date.now() + 3_600_000).toISOString() }, /clock is ahead/],
    ['a stale timestamp', { capturedAt: new Date(Date.now() - 3_600_000).toISOString() }, /more than 15 minutes old/],
  ])('refuses a capture from %s, without opening the file', async (_name, over, message) => {
    const res = await check(files.good, { capture: capture(over) }).expect(201);
    expect(res.body).toMatchObject({ success: true, passed: false });
    expect(res.body.message).toMatch(message);
    expect(res.body.walkthroughToken).toBeUndefined();
    expect(redisWrites).toHaveLength(0);
  });

  it('refuses a file with no video picture in it', async () => {
    const res = await check(files.audioOnly).expect(201);
    expect(res.body).toMatchObject({ passed: false });
    expect(res.body.message).toMatch(/no video picture/);
    expect(redisWrites).toHaveLength(0);
  });

  it('does not block the host when the analyser itself fails: passes as unanalysed, with the capture, for a person to review', async () => {
    const service = app.get(HostListingsService) as unknown as { exif: { read: () => Promise<never> } };
    service.exif.read = async () => {
      throw new Error('Task timed out');
    };
    const res = await check(files.good).expect(201);
    expect(res.body).toMatchObject({ passed: true, method: 'unanalysed', needsVisualReview: true, message: 'Video received. Our team will review it.' });
    expect(JSON.parse(redisWrites[0].value).check).toMatchObject({ method: 'unanalysed', visuallyVerified: false, capture: { source: 'device_reported' } });
    await settle();
    expect(uploads).toHaveLength(1);
  });

  it('still checks the capture location when the analyser is down', async () => {
    const service = app.get(HostListingsService) as unknown as { exif: { read: () => Promise<never> } };
    service.exif.read = async () => {
      throw new Error('Task timed out');
    };
    const res = await check(files.good, { capture: capture({ lat: 32.2396, lng: 77.1887 }) }).expect(201);
    expect(res.body).toMatchObject({ passed: false });
    expect(redisWrites).toHaveLength(0);
  });

  it('refuses a video that is too short', async () => {
    const res = await check(files.short).expect(201);
    expect(res.body).toMatchObject({ passed: false });
    expect(res.body.message).toMatch(/only 4s long/);
  });

  it('still passes — and the server survives — when the background storage upload fails', async () => {
    for (const behaviour of ['error', 'throws'] as const) {
      storageBehaviour = behaviour;
      const res = await check(files.good).expect(201);
      expect(res.body).toMatchObject({ passed: true });
      await settle();
    }
    storageBehaviour = 'ok';
    expect((await check(files.good).expect(201)).body.passed).toBe(true);
    await settle();
  });

  it('answers right after the check, without waiting for the storage upload', async () => {
    storageBehaviour = 'slow';
    const started = Date.now();
    const res = await check(files.good).expect(201);
    const took = Date.now() - started;
    expect(res.body).toMatchObject({ passed: true });
    expect(took).toBeLessThan(2500);
    await settle(4600);
    expect(uploads).toHaveLength(1);
  });

  it('retries the token save once when the first attempt fails, and still passes', async () => {
    redisFailures = 1;
    const res = await check(files.good).expect(201);
    expect(res.body).toMatchObject({ passed: true });
    expect(redisWrites).toHaveLength(1);
    await settle();
  });

  it('does not report a pass when the token cannot be saved, and keeps nothing', async () => {
    redisFailures = 99;
    const res = await check(files.good).expect(201);
    expect(res.body).toMatchObject({ success: true, passed: false });
    expect(res.body.message).toMatch(/send the video again/);
    expect(res.body.walkthroughToken).toBeUndefined();
    await settle();
    expect(uploads).toHaveLength(0);
  });

  it('asks for a file, and a pin, with a readable 400', async () => {
    const noFile = await check(null).expect(400);
    expect(noFile.body).toMatchObject({ success: false, statusCode: 400, message: 'No file provided', error: 'No file provided' });

    const blankPin = await check(files.good, { pin: { lat: '', lng: '' } }).expect(400);
    expect(blankPin.body.message).toMatch(/Drop the pin/);
    const missingPin = await check(files.good, { pin: {} }).expect(400);
    expect(missingPin.body.message).toMatch(/Drop the pin/);
    expect(redisWrites).toHaveLength(0);
  });

  it('rejects an unsupported video type with a readable 400', async () => {
    const res = await check(files.good, undefined, 'video/x-flv').expect(400);
    expect(res.body.message).toMatch(/MP4, WebM or MOV/);
  });

  it('cleans up the uploaded temp file, pass or fail', async () => {
    const before = fs.readdirSync(os.tmpdir()).length;
    await check(files.good).expect(201);
    await check(files.good, { capture: capture({ accuracy: 900 }) }).expect(201);
    await check(files.good, { capture: null }).expect(400);
    await settle(600);
    expect(fs.readdirSync(os.tmpdir()).length).toBeLessThanOrEqual(before);
  });

  it('no longer accepts gallery video uploads for the property video', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/host/listings/media/video')
      .attach('video', fs.readFileSync(files.good), { filename: 'good.mp4', contentType: 'video/mp4' })
      .expect(400);
    expect(res.body.message).toMatch(/can no longer be uploaded/);
    expect(uploads).toHaveLength(0);
  });
});

describe('POST /api/host/listings/media/photos', () => {
  let app: INestApplication;
  let redisStore: Map<string, string>;
  let uploadedBuffers: Record<string, Buffer>;
  let jpegWithGps: Buffer;
  let cleanJpeg: Buffer;

  beforeAll(async () => {
    const withGps = path.join(tmp, 'gps.jpg');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1', '-frames:v', '1', withGps]);
    await exiftool.write(withGps, { GPSLatitude: PIN.lat, GPSLongitude: PIN.lng, GPSLatitudeRef: 'N', GPSLongitudeRef: 'E', Make: 'Acme', Model: 'PhoneX' } as never, ['-overwrite_original']);
    jpegWithGps = fs.readFileSync(withGps);
    const clean = path.join(tmp, 'clean.jpg');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1', '-frames:v', '1', clean]);
    cleanJpeg = fs.readFileSync(clean);
  }, 60_000);

  beforeEach(async () => {
    redisStore = new Map();
    uploadedBuffers = {};
    const moduleRef = await Test.createTestingModule({
      controllers: [HostListingsController],
      providers: [
        HostListingsService,
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: getRepositoryToken(ListingEntity), useValue: {} },
        { provide: getRepositoryToken(UserEntity), useValue: {} },
        { provide: getDataSourceToken(), useValue: {} },
        { provide: VerificationService, useValue: {} },
        {
          provide: RedisService,
          useValue: {
            set: async (key: string, value: string) => (redisStore.set(key, value), true),
            get: async (key: string) => redisStore.get(key) ?? null,
            del: async (key: string) => void redisStore.delete(key),
          },
        },
        {
          provide: SupabaseProvider,
          useValue: {
            client: {
              storage: {
                from: () => ({
                  upload: async (p: string, body: Buffer) => ((uploadedBuffers[p] = body), { error: null }),
                  getPublicUrl: (p: string) => ({ data: { publicUrl: `https://storage.test/${p}` } }),
                }),
              },
            },
          },
        },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: (ctx: any) => ((ctx.switchToHttp().getRequest().user = { userId: 'u1' }), true) })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterEach(async () => app.close());

  const send = (
    photos: { data: Buffer; type?: string }[],
    opts: { rooms?: unknown; captures?: unknown; pin?: Record<string, string> } = {},
  ) => {
    let r = request(app.getHttpServer()).post('/api/host/listings/media/photos');
    for (const [k, v] of Object.entries(opts.pin ?? { lat: String(PIN.lat), lng: String(PIN.lng) })) r = r.field(k, v);
    r = r.field('rooms', JSON.stringify(opts.rooms ?? photos.map(() => 'living')));
    if (opts.captures !== null) r = r.field('captures', JSON.stringify(opts.captures ?? photos.map(() => capture())));
    photos.forEach((p, i) => (r = r.attach('files', p.data, { filename: `p${i}.jpg`, contentType: p.type ?? 'image/jpeg' })));
    return r;
  };

  it('stores a captured photo and a capture receipt for it, and reports the distance', async () => {
    const res = await send([{ data: cleanJpeg }]).expect(201);
    expect(res.body.photos).toHaveLength(1);
    const [photo] = res.body.photos;
    expect(photo).toMatchObject({ room: 'living', capture: { accuracyM: 12 } });
    expect(photo.url).toMatch(/^https:\/\/storage\.test\/u1\/photos\/.+\.jpg$/);
    expect(Object.keys(uploadedBuffers)).toHaveLength(1);
    const receipts = [...redisStore.entries()].filter(([k]) => k.startsWith('capture-receipt:u1:'));
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0][1])).toMatchObject({ kind: 'photo', source: 'device_reported' });
  });

  it('strips EXIF / GPS / device metadata from the stored photo', async () => {
    const gpsFile = path.join(tmp, 'check-before.jpg');
    fs.writeFileSync(gpsFile, jpegWithGps);
    const tagsBefore = await exiftool.read(gpsFile);
    expect(tagsBefore.GPSLatitude).toBeDefined();

    await send([{ data: jpegWithGps }]).expect(201);
    const [stored] = Object.values(uploadedBuffers);
    const storedFile = path.join(tmp, 'stored.jpg');
    fs.writeFileSync(storedFile, stored);
    const tagsAfter = await exiftool.read(storedFile);
    expect(tagsAfter.GPSLatitude).toBeUndefined();
    expect(tagsAfter.GPSLongitude).toBeUndefined();
    expect(tagsAfter.Make).toBeUndefined();
    expect(tagsAfter.Model).toBeUndefined();
    expect(tagsAfter.ImageWidth).toBe(320);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-v', 'error', '-i', storedFile, '-f', 'null', '-']);
  });

  it('refuses a photo with no capture details, naming the camera', async () => {
    const res = await send([{ data: cleanJpeg }], { captures: null }).expect(400);
    expect(res.body.message).toMatch(/in-app camera/);
    expect(Object.keys(uploadedBuffers)).toHaveLength(0);
  });

  it.each([
    ['another town', { lat: 32.2396, lng: 77.1887 }, /captured .* from the pin/],
    ['outside Himachal Pradesh', { lat: 28.6139, lng: 77.209 }, /outside Himachal Pradesh/],
    ['a poor fix', { accuracy: 250 }, /only to within 250 m/],
    ['a stale timestamp', { capturedAt: new Date(Date.now() - 20 * 60_000).toISOString() }, /more than 5 minutes old/],
    ['a future timestamp', { capturedAt: new Date(Date.now() + 20 * 60_000).toISOString() }, /clock is ahead/],
  ])('refuses a photo captured at %s and uploads nothing', async (_n, over, message) => {
    const res = await send([{ data: cleanJpeg }, { data: cleanJpeg }], { captures: [capture(), capture(over)] }).expect(400);
    expect(res.body.message).toMatch(/^Photo 2: /);
    expect(res.body.message).toMatch(message);
    expect(Object.keys(uploadedBuffers)).toHaveLength(0);
    expect(redisStore.size).toBe(0);
  });

  it('refuses a missing pin, mismatched arrays, a non-JPEG and a gallery PNG', async () => {
    expect((await send([{ data: cleanJpeg }], { pin: {} }).expect(400)).body.message).toMatch(/Drop the pin/);
    expect((await send([{ data: cleanJpeg }], { captures: [] }).expect(400)).body.message).toMatch(/in-app camera/);
    expect((await send([{ data: cleanJpeg }], { rooms: ['living', 'bedroom'] }).expect(400)).body.message).toMatch(/exactly one room/);
    expect((await send([{ data: cleanJpeg, type: 'image/png' }]).expect(400)).body.message).toMatch(/in-app camera/);
    expect((await send([{ data: Buffer.from('not a jpeg at all') }]).expect(400)).body.message).toMatch(/not a JPEG/);
    expect(Object.keys(uploadedBuffers)).toHaveLength(0);
  });
});

afterAll(async () => {
  await exiftool.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});
