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
import { evaluateCaptureEvidence } from '../src/listings/capture-evidence.util';
import { CaptureConfigService } from '../src/listings/capture-config.service';
import { HostListingsController } from '../src/listings/host-listings.controller';
import { HostListingsService } from '../src/listings/host-listings.service';
import { RedisService } from '../src/redis/redis.service';
import { VerificationService } from '../src/verification/verification.service';

const MOHALI = { lat: 30.7046, lng: 76.7179 };
const ROOMS = ['exterior', 'living', 'bedroom', 'kitchen', 'bath'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-submit-flow-'));
const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);

type Row = Record<string, any>;

describe('host listing submission, API only (Mohali pin)', () => {
  let app: INestApplication;
  let jpeg: Buffer;
  let video: Buffer;
  let redisStore: Map<string, string>;
  let rows: Row[];
  let captureConfig: { locationBypass: boolean };
  let status: { identity: { status: string } };
  let profile: Row;

  beforeAll(() => {
    const j = path.join(tmp, 'a.jpg');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1', '-frames:v', '1', j]);
    jpeg = fs.readFileSync(j);
    const v = path.join(tmp, 'w.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=20:size=160x120:rate=10', '-pix_fmt', 'yuv420p', v]);
    video = fs.readFileSync(v);
  }, 60_000);

  beforeEach(async () => {
    redisStore = new Map();
    rows = [];
    captureConfig = { locationBypass: true };
    status = { identity: { status: 'verified' } };
    profile = { id: 'u1', host_kind: 'individual', gst: null, selfie_uploaded_at: new Date() };

    const listingsRepo = {
      findOne: async ({ where }: any) => rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
      create: (x: Row) => ({ review_notes: null, review_reason_category: null, updated_at: null, created_at: new Date(), ...x }),
      save: async (x: Row) => {
        x.id = x.id ?? `L${rows.length + 1}`;
        if (!rows.includes(x)) rows.push(x);
        return x;
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [HostListingsController],
      providers: [
        HostListingsService,
        { provide: CaptureConfigService, useValue: captureConfig },
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: getRepositoryToken(ListingEntity), useValue: listingsRepo },
        { provide: getRepositoryToken(UserEntity), useValue: { findOne: async () => profile } },
        { provide: getDataSourceToken(), useValue: { transaction: async (cb: any) => cb({ getRepository: () => listingsRepo }) } },
        { provide: VerificationService, useValue: { getMyStatus: async () => status } },
        {
          provide: RedisService,
          useValue: {
            set: async (k: string, v: string) => (redisStore.set(k, v), true),
            get: async (k: string) => redisStore.get(k) ?? null,
            del: async (k: string) => void redisStore.delete(k),
            incrementVersion: async () => undefined,
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
  });
  afterEach(async () => app.close());

  const U = '/api/host/listings';
  const api = () => request(app.getHttpServer());
  const auth = { Authorization: 'Bearer t' };

  const uploadPhotos = (claims: unknown[] = ROOMS.map(() => null)) => {
    let r = api().post(`${U}/media/photos`).set(auth).field('lat', String(MOHALI.lat)).field('lng', String(MOHALI.lng)).field('rooms', JSON.stringify(ROOMS)).field('captures', JSON.stringify(claims));
    for (const room of ROOMS) r = r.attach('files', jpeg, { filename: `${room}.jpg`, contentType: 'image/jpeg' });
    return r;
  };
  const uploadWalkthrough = () =>
    api()
      .post(`${U}/media/walkthrough`)
      .set(auth)
      .field('lat', String(MOHALI.lat))
      .field('lng', String(MOHALI.lng))
      .field('capture', '{}')
      .field('durationSeconds', '20')
      .attach('video', video, { filename: 'w.mp4', contentType: 'video/mp4' });

  const form = (photos: unknown[], walkthrough: Row, over: Row = {}) => ({
    title: 'Mohali Test Cabin',
    propertyType: 'house',
    placeType: 'entire',
    beds: '2BHK',
    bedrooms: 2,
    bathrooms: 1,
    maxGuests: 4,
    district: 'Solan',
    tehsil: 'Parwanoo',
    town: 'Parwanoo',
    streetAddress: 'Phase 7, Sector 61',
    city: 'Mohali',
    state: 'Himachal Pradesh',
    pincode: '160062',
    ...MOHALI,
    description: 'A quiet two-bedroom home used to test the listing submission API end to end. '.repeat(3),
    photos,
    dailyBaseRate: 1800,
    weeklyDiscountPct: 5,
    monthlyDiscountPct: 10,
    minDays: 2,
    availableFrom: '2026-10-20',
    billsIncluded: 'all',
    checkIn: '12:00 pm – 9:00 pm',
    checkOut: 'Before 11:00 am',
    pets: false,
    smoking: false,
    cancellation: 'moderate',
    categories: ['quiet'],
    amenities: ['Wifi', 'Kitchen', 'Heating'],
    walkthroughPassed: true,
    walkthroughToken: walkthrough.walkthroughToken,
    walkthroughVideoUrl: walkthrough.walkthroughVideoUrl,
    ...over,
  });

  const capture = async () => {
    const cfg = await api().get(`${U}/capture-config`).set(auth).expect(200);
    expect(cfg.body).toMatchObject({ success: true, locationBypass: true });
    const photos = await uploadPhotos().expect(201);
    expect(photos.body.photos).toHaveLength(ROOMS.length);
    const walk = await uploadWalkthrough().expect(201);
    expect(walk.body).toMatchObject({ success: true, passed: true, walkthroughToken: expect.any(String) });
    return { photos: photos.body.photos.map(({ url, room }: Row) => ({ url, room })), walk: walk.body };
  };

  it('bypass ON: capture -> submit-full from Mohali is accepted and queued for review, flagged as bypassed', async () => {
    const { photos, walk } = await capture();

    const res = await api().post(`${U}/submit-full`).set(auth).send(form(photos, walk)).expect(201);
    expect(res.body).toMatchObject({ success: true, status: 'in_review', listingId: expect.any(String) });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ host_id: 'u1', status: 'in_review' });
    expect(rows[0].draft_data.property_details).toMatchObject({ title: 'Mohali Test Cabin', lat: MOHALI.lat, lng: MOHALI.lng, city: 'Mohali' });
    expect(rows[0].draft_data.property_details.photos).toHaveLength(ROOMS.length);
    expect(rows[0].draft_data.identity).toEqual({ gst: '' });

    const evidence = evaluateCaptureEvidence(rows[0].draft_data);
    expect(evidence.status).not.toBe('passed');
    expect(evidence.problems.join(' ')).toMatch(/bypassed/);

    const again = await api().post(`${U}/submit-full`).set(auth).send(form(photos, walk)).expect(400);
    expect(again.body.message).toMatch(/expired or was already used/);
    expect(rows).toHaveLength(1);
  });

  it('the gate is identity + selfie only: either missing is a 403 with nothing stored or spent', async () => {
    const { photos, walk } = await capture();
    const submit = () => api().post(`${U}/submit-full`).set(auth).send(form(photos, walk));

    status.identity.status = 'pending';
    expect((await submit().expect(403)).body.message).toMatch(/Verify your identity/);
    status.identity.status = 'verified';

    profile.selfie_uploaded_at = null;
    expect((await submit().expect(403)).body.message).toMatch(/live selfie/);
    profile.selfie_uploaded_at = new Date();

    expect(rows).toHaveLength(0);
    await submit().expect(201);
    expect(rows).toHaveLength(1);
  });

  it('bypass OFF: a Mohali pin cannot be captured or submitted', async () => {
    captureConfig.locationBypass = false;
    const claim = { lat: MOHALI.lat, lng: MOHALI.lng, accuracy: 10, capturedAt: new Date().toISOString() };
    const photo = await uploadPhotos(ROOMS.map(() => claim)).expect(400);
    expect(photo.body.message).toMatch(/outside Himachal Pradesh/);

    const submit = await api().post(`${U}/submit-full`).set(auth).send(form([], {}, { walkthroughToken: undefined })).expect(400);
    expect(rows).toHaveLength(0);
    expect(submit.body.success).toBe(false);
  });
});
