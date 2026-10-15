import { createHash } from 'crypto';
import cookieParser from 'cookie-parser';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { FindOperator } from 'typeorm';
import { INestApplication, NotFoundException, ConflictException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { AdminController } from '../src/admin/admin.controller';
import { AdminService } from '../src/admin/admin.service';
import { AdminGuard } from '../src/auth/admin.guard';
import { AuthGuard, SESSION_COOKIE } from '../src/auth/auth.guard';
import { SupabaseProvider } from '../src/auth/supabase.provider';
import { BookingsService } from '../src/bookings/bookings.service';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { ResponseMessageInterceptor } from '../src/common/interceptors/response-message.interceptor';
import {
  BookingEntity,
  DisputeCaseEntity,
  ListingEntity,
  NotificationLogEntity,
  PaymentEntity,
  UserEntity,
  VerificationAuditLogEntity,
  VerificationRequestEntity,
} from '../src/entities';
import { CaptureConfigService } from '../src/listings/capture-config.service';
import { HostListingsController } from '../src/listings/host-listings.controller';
import { HostListingsService } from '../src/listings/host-listings.service';
import { ListingTranslationService } from '../src/listings/listing-translation.service';
import { ListingsService } from '../src/listings/listings.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { RedisService } from '../src/redis/redis.service';
import { StorageService } from '../src/storage/storage.service';
import { VerificationService } from '../src/verification/verification.service';

/**
 * HTTP-level e2e for every non-media endpoint of AdminController and
 * HostListingsController. Real controllers, real services, real AuthGuard
 * (signed JWT in the session cookie) and real AdminGuard, real
 * ValidationPipe / ApiExceptionFilter / ResponseMessageInterceptor. Only the
 * database, Redis, storage, notifications and the booking engine are faked.
 */

const JWT_SECRET = 'test-secret';
const token = (sub: string, opts: jwt.SignOptions = {}) => jwt.sign({ sub }, JWT_SECRET, opts);
const as = (sub: string) => `${SESSION_COOKIE}=${token(sub)}`;

/* ── tiny in-memory repository ─────────────────────────────────────────── */

type Row = Record<string, any>;
const matches = (r: Row, where: any): boolean =>
  Array.isArray(where) ? where.some((w) => matches(r, w)) : !where || Object.entries(where).every(([k, v]) => (v instanceof FindOperator ? (v.value as any[]).includes(r[k]) : r[k] === v));
const sortBy = (rows: Row[], order?: Record<string, 'ASC' | 'DESC'>) => {
  if (!order) return rows;
  const [k, dir] = Object.entries(order)[0];
  const t = (v: any) => (v instanceof Date ? v.getTime() : v ?? 0);
  return [...rows].sort((a, b) => (t(a[k]) - t(b[k])) * (dir === 'DESC' ? -1 : 1));
};
function makeRepo(rows: Row[]) {
  let seq = 0;
  return {
    rows,
    find: async ({ where, order }: any = {}) => sortBy(rows.filter((r) => matches(r, where)), order).map((r) => ({ ...r })),
    findOne: async ({ where, order }: any = {}) => {
      const m = sortBy(rows.filter((r) => matches(r, where)), order);
      return m[0] ?? null;
    },
    update: async (where: any, patch: Row) => {
      rows.filter((r) => matches(r, where)).forEach((r) => Object.assign(r, patch));
    },
    count: async () => rows.length,
    create: (x: Row) => ({ review_notes: null, review_reason_category: null, updated_at: null, created_at: new Date(), ...x }),
    save: async (x: Row) => {
      x.id = x.id ?? `new-${++seq}`;
      if (!rows.includes(x)) rows.push(x);
      return x;
    },
  };
}

const USERS = {
  admin: { id: 'admin1', role: 'admin', full_name: 'Ops Admin', isHost: false },
  host: { id: 'host1', role: 'host', full_name: 'Hema Host', phone: '+911', email: 'h@x.in', isHost: true, selfie_uploaded_at: new Date(), bank_verified_at: new Date(), host_kind: 'individual', pan: 'ABCDE1234F', gst: null },
  guest: { id: 'guest1', role: 'guest', full_name: 'Gita Guest', email: 'g@x.in', isHost: false },
  other: { id: 'host2', role: 'host', full_name: 'Other Host', isHost: true, selfie_uploaded_at: new Date(), bank_verified_at: new Date(), host_kind: 'individual', pan: 'ABCDE1234F', gst: null },
};

const expectError = (res: request.Response, status: number, message?: string | RegExp) => {
  expect(res.status).toBe(status);
  expect(res.body).toMatchObject({ success: false, statusCode: status });
  expect(res.body.error).toBe(res.body.message);
  if (typeof message === 'string') expect(res.body.message).toBe(message);
  else if (message) expect(res.body.message).toMatch(message);
};

/* ══════════════════════════════════════════════════════════════════════════
 *  ADMIN
 * ══════════════════════════════════════════════════════════════════════ */

describe('Admin API (/api/admin)', () => {
  let app: INestApplication;
  let listings: Row[];
  let profiles: Row[];
  let payments: Row[];
  let bookings: Row[];
  let vreqs: Row[];
  let vaudit: Row[];
  let notifLog: Row[];
  let notified: any[];
  let cacheBumps: number;
  let bookingCalls: any[];
  let bookingFail: Error | null;

  /** A listing whose camera-capture evidence passes (so the approval gate only waits on banking). */
  const goodDraft = () => {
    const rec = (kind: string) => ({ kind, lat: 32.2, lng: 77.1, accuracyM: 10, capturedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), distanceFromPinM: 5, source: 'device_reported' });
    return {
      property_details: { title: 'Pine Cabin', town: 'Manali', lat: 32.2, lng: 77.1, photos: [{ url: 'https://x/p1.jpg', room: 'living' }], dailyBaseRate: 1000 },
      telemetry: { walkthroughPassed: true, walkthroughVideoUrl: 'https://proj.supabase.co/storage/v1/object/public/listing-media/host1/w.mp4', walkthroughCheck: { method: 'camera_captured', capture: rec('video') } },
      captures: { photos: { 'https://x/p1.jpg': rec('photo') } },
    };
  };

  beforeEach(async () => {
    listings = [
      { id: 'L1', host_id: 'host1', status: 'in_review', draft_data: goodDraft(), review_notes: null, created_at: new Date('2026-01-02'), updated_at: new Date('2026-01-03') },
      { id: 'L2', host_id: 'host2', status: 'live', draft_data: { property_details: { title: 'Sky Loft', town: 'Shimla' } }, created_at: new Date('2026-01-01'), updated_at: null },
      { id: 'L3', host_id: 'host1', status: 'draft', draft_data: null, created_at: new Date('2026-01-04'), updated_at: null },
    ];
    profiles = Object.values(USERS).map((u) => ({ created_at: new Date('2025-05-05'), ...u }));
    payments = [{ id: 'pay1', booking_id: 'B1', amount: 5000, status: 'paid', cashfree_order_id: 'o1', cashfree_payout_id: null, created_at: new Date(), updated_at: new Date() }, { id: 'pay2', booking_id: 'B2', amount: 100, status: 'refunded', created_at: new Date(), updated_at: new Date() }];
    bookings = [
      { id: 'B1', status: 'disputed', listing_id: 'L2', guest_id: 'guest1', host_id: 'host2', due_at_move_in: 4000, checkin_time: null, rejection_reason: 'dirty', updated_at: new Date() },
      { id: 'B2', status: 'confirmed', listing_id: 'L2', guest_id: 'guest1', host_id: 'host2', updated_at: new Date() },
    ];
    vreqs = [
      { id: 'V1', user_id: 'host1', verification_type: 'bank', status: 'pending', document_path: 'host1/bank/a.jpg', document_path_back: null, bank_account_holder_name: 'Hema Host', bank_ifsc: 'HDFC0001', bank_account_number: '123', bank_name: 'HDFC', submitted_at: new Date('2026-02-02'), reviewed_by: null },
      { id: 'V0', user_id: 'host1', verification_type: 'bank', status: 'rejected', rejection_reason: 'blurry', submitted_at: new Date('2026-02-01'), reviewed_by: 'admin1', document_path: null },
      { id: 'V2', user_id: 'host1', verification_type: 'selfie', status: 'pending', document_path: 'host1/selfie/s.jpg', submitted_at: new Date('2026-02-03'), reviewed_by: null },
      { id: 'V3', user_id: 'host1', verification_type: 'pan', status: 'pending', document_path: null, submitted_at: new Date('2026-02-04'), reviewed_by: null },
      { id: 'V4', user_id: 'host1', verification_type: 'identity', status: 'pending', document_path: 'host1/id/a.jpg', submitted_at: new Date('2026-02-05'), reviewed_by: null },
      { id: 'V5', user_id: 'host1', verification_type: 'pan', status: 'verified', document_path: 'p', submitted_at: new Date('2026-01-01'), reviewed_by: 'admin1' },
    ];
    vaudit = [];
    notifLog = [];
    notified = [];
    cacheBumps = 0;
    bookingCalls = [];
    bookingFail = null;

    const listingsRepo = {
      ...makeRepo(listings),
      createQueryBuilder: () => {
        const st: { status?: string; sel?: string; join?: boolean } = {};
        const qb: any = {
          orderBy: () => qb,
          limit: () => qb,
          skip: () => qb,
          take: () => qb,
          where: () => qb,
          addSelect: () => qb,
          groupBy: () => qb,
          innerJoin: () => ((st.join = true), qb),
          select: (f: string) => ((st.sel = f), qb),
          andWhere: (_s: string, p: any) => (p?.status && (st.status = p.status), qb),
          getMany: async () => listings,
          getManyAndCount: async () => {
            const m = listings.filter((l) => !st.status || l.status === st.status);
            return [m, m.length];
          },
          getRawMany: async () => {
            if (st.sel === 'l.host_id') {
              const c: Record<string, number> = {};
              listings.forEach((l) => (c[l.host_id] = (c[l.host_id] ?? 0) + 1));
              return Object.entries(c).map(([host_id, count]) => ({ host_id, count: String(count) }));
            }
            const c: Record<string, number> = {};
            listings.forEach((l) => (c[l.status] = (c[l.status] ?? 0) + 1));
            return Object.entries(c).map(([status, count]) => ({ status, count: String(count) }));
          },
          getRawOne: async () => (st.join ? { total: '2', verified: '1' } : { total: '2', passed: '1' }),
        };
        return qb;
      },
    };

    const profilesRepo = {
      ...makeRepo(profiles),
      createQueryBuilder: () => {
        const st: { where: string[] } = { where: [] };
        const pick = () => {
          const w = st.where.join(' ');
          return profiles.filter((p) => {
            if (w.includes("p.role = 'admin'") && !w.includes('!=')) return p.role === 'admin';
            if (w.includes('p.isHost IS NOT TRUE')) return !(p.isHost || p.role === 'host') && p.role !== 'admin';
            if (w.includes('p.isHost = true')) return (p.isHost || p.role === 'host') && p.role !== 'admin';
            return true;
          });
        };
        const qb: any = {
          orderBy: () => qb,
          skip: () => qb,
          take: () => qb,
          where: (s: string) => (st.where.push(s), qb),
          andWhere: (s: string) => (st.where.push(s), qb),
          getMany: async () => pick(),
          getManyAndCount: async () => [pick(), pick().length],
          getCount: async () => pick().length,
        };
        return qb;
      },
    };

    const paymentsRepo = {
      ...makeRepo(payments),
      createQueryBuilder: () => {
        let status: string | undefined;
        const qb: any = {
          orderBy: () => qb,
          andWhere: (_s: string, p: any) => ((status = p.status), qb),
          getMany: async () => payments.filter((p) => !status || p.status === status),
        };
        return qb;
      },
    };

    const notifRepo = {
      createQueryBuilder: () => {
        const qb: any = { where: () => qb, orderBy: () => qb, limit: () => qb, getMany: async () => notifLog };
        return qb;
      },
    };

    const auditRepo = { find: async () => vaudit, create: (x: Row) => x, save: async (x: Row) => (vaudit.push({ id: `a${vaudit.length}`, ...x }), x) };

    const bookingsService = {
      getDisputeCase: async (adminId: string, id: string) => {
        bookingCalls.push(['case', adminId, id]);
        if (id === 'nope') throw new NotFoundException('Booking not found');
        return { bookingId: id, timeline: [] };
      },
      resolveDispute: async (adminId: string, id: string, amount: number, message?: string) => {
        bookingCalls.push(['resolve', adminId, id, amount, message]);
        if (bookingFail) throw bookingFail;
        return { success: true, bookingId: id, amountToGuest: amount };
      },
      resolveAppeal: async (adminId: string, id: string, amount: number, message?: string) => {
        bookingCalls.push(['appeal', adminId, id, amount, message]);
        if (bookingFail) throw bookingFail;
        return { success: true, bookingId: id, amountToGuest: amount };
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        AdminService,
        AuthGuard,
        AdminGuard,
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: ConfigService, useValue: { get: (k: string) => ({ SUPABASE_JWT_SECRET: JWT_SECRET })[k] } },
        { provide: getRepositoryToken(ListingEntity), useValue: listingsRepo },
        { provide: getRepositoryToken(UserEntity), useValue: profilesRepo },
        { provide: getRepositoryToken(BookingEntity), useValue: makeRepo(bookings) },
        { provide: getRepositoryToken(NotificationLogEntity), useValue: notifRepo },
        { provide: getRepositoryToken(PaymentEntity), useValue: paymentsRepo },
        { provide: getRepositoryToken(DisputeCaseEntity), useValue: makeRepo([]) },
        { provide: getRepositoryToken(VerificationRequestEntity), useValue: makeRepo(vreqs) },
        { provide: getRepositoryToken(VerificationAuditLogEntity), useValue: auditRepo },
        { provide: NotificationsService, useValue: { notify: (...a: any[]) => notified.push(a) } },
        { provide: ListingTranslationService, useValue: { prewarmSourceLocale: async () => {} } },
        { provide: ListingsService, useValue: { bumpSearchCacheVersion: async () => void cacheBumps++ } },
        { provide: BookingsService, useValue: bookingsService },
        {
          provide: StorageService,
          useValue: {
            createSignedDownloadUrl: async (bucket: string, path: string) => {
              if (path.includes('gone')) throw new Error('Object not found');
              return `https://signed.test/${bucket}/${path}`;
            },
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const api = () => request(app.getHttpServer());
  const adm = (m: 'get' | 'post' | 'patch', url: string) => api()[m](url).set('Cookie', as('admin1'));

  /* ── auth: every route ─────────────────────────────────────────────── */

  const ROUTES: [string, string, string, any][] = [
    ['get', 'GET', '/api/admin/audits', {}],
    ['get', 'GET', '/api/admin/properties', {}],
    ['get', 'GET', '/api/admin/properties/L1/walkthrough-url', {}],
    ['patch', 'PATCH', '/api/admin/properties/L1', { reviewNotes: 'x' }],
    ['get', 'GET', '/api/admin/stats', {}],
    ['get', 'GET', '/api/admin/users', {}],
    ['patch', 'PATCH', '/api/admin/users/guest1', { isHost: true }],
    ['get', 'GET', '/api/admin/payments', {}],
    ['get', 'GET', '/api/admin/disputes', {}],
    ['get', 'GET', '/api/admin/disputes/B1', {}],
    ['patch', 'PATCH', '/api/admin/disputes/B1', { amountToGuest: 1 }],
    ['patch', 'PATCH', '/api/admin/disputes/B1/appeal', { amountToGuest: 1 }],
    ['get', 'GET', '/api/admin/users/host1/verification', {}],
    ['get', 'GET', '/api/admin/verification/V1', {}],
    ['post', 'POST', '/api/admin/verification/V1/review', { decision: 'approve' }],
    ['get', 'GET', '/api/admin/verification/V1/document-url', {}],
  ];

  describe('authentication and authorisation (all routes)', () => {
    it.each(ROUTES)('%s %s %s -> 401 without a session cookie', async (m, _label, url, body) => {
      const res = await (api() as any)[m](url).send(body);
      expectError(res, 401, 'No session cookie found');
    });

    it.each(ROUTES)('%s %s %s -> 401 with a forged token', async (m, _label, url, body) => {
      const bad = jwt.sign({ sub: 'admin1' }, 'wrong-secret');
      const res = await (api() as any)[m](url).set('Cookie', `${SESSION_COOKIE}=${bad}`).send(body);
      expectError(res, 401, 'Invalid or expired session');
    });

    it.each(ROUTES)('%s %s %s -> 403 for a non-admin', async (m, _label, url, body) => {
      for (const who of ['host1', 'guest1']) {
        const res = await (api() as any)[m](url).set('Cookie', as(who)).send(body);
        expectError(res, 403, 'Admin role required');
      }
      // and nothing was mutated
      expect(vaudit).toHaveLength(0);
      expect(profiles.find((p) => p.id === 'guest1')!.isHost).toBe(false);
    });

    it('401 for an expired token and 403 for a valid token whose user has no profile', async () => {
      expectError(await api().get('/api/admin/stats').set('Cookie', `${SESSION_COOKIE}=${token('admin1', { expiresIn: -10 })}`), 401, 'Session expired');
      expectError(await api().get('/api/admin/stats').set('Cookie', as('ghost')), 403, 'No profile found for user');
    });

    it('accepts the cookie in its JSON {access_token} form', async () => {
      const raw = encodeURIComponent(JSON.stringify({ access_token: token('admin1') }));
      await api().get('/api/admin/stats').set('Cookie', `${SESSION_COOKIE}=${raw}`).expect(200);
    });
  });

  /* ── audits ──────────────────────────────────────────────────────── */

  describe('GET /audits', () => {
    it('maps notification-log rows to audit events', async () => {
      notifLog = [{ id: 'n1', event: 'banking_passed', payload: { notes: 'all good', actor: 'Ops' }, sent_at: new Date() }];
      const res = await adm('get', '/api/admin/audits').expect(200);
      expect(res.body.total).toBe(1);
      expect(res.body.audits[0]).toMatchObject({ id: 'n1', kind: 'banking', title: 'Banking Verification — Passed ✓', desc: 'all good', actor: 'Ops' });
    });

    it('falls back to events synthesised from listings when the log is empty', async () => {
      listings[0].draft_data = { telemetry: { status: 'passed' }, banking: { status: 'failed' } };
      const res = await adm('get', '/api/admin/audits').expect(200);
      expect(res.body.audits.map((a: any) => a.id).sort()).toEqual(['banking-L1', 'telemetry-L1']);
      expect(res.body.total).toBe(2);
    });
  });

  /* ── properties list ───────────────────────────────────────────────── */

  describe('GET /properties', () => {
    it('lists listings with host, layers, verification and status counts', async () => {
      const res = await adm('get', '/api/admin/properties').expect(200);
      expect(res.body).toMatchObject({ total: 3, page: 1, pageSize: 20, counts: { all: 3, in_review: 1, live: 1, draft: 1, changes_needed: 0 } });
      const l1 = res.body.properties.find((p: any) => p.id === 'L1');
      expect(l1).toMatchObject({ title: 'Pine Cabin', town: 'Manali', hostName: 'Hema Host', status: 'in_review', price: expect.any(Number) });
      expect(l1.layers.telemetry.status).toBe('passed');
      expect(l1.layers.banking.status).toBe('submitted'); // newest bank request is still pending
      expect(l1.verification.bank).toMatchObject({ requestId: 'V1', hasDocument: true });
    });

    it('filters by status', async () => {
      const res = await adm('get', '/api/admin/properties?status=live').expect(200);
      expect(res.body.properties.map((p: any) => p.id)).toEqual(['L2']);
      expect(res.body.counts.all).toBe(3); // counts ignore the filter
    });

    it('searches title / town / host name case-insensitively', async () => {
      expect((await adm('get', '/api/admin/properties?q=SKY').expect(200)).body.properties.map((p: any) => p.id)).toEqual(['L2']);
      expect((await adm('get', '/api/admin/properties?q=hema').expect(200)).body.total).toBe(2);
      expect((await adm('get', '/api/admin/properties?q=zzz').expect(200)).body.properties).toEqual([]);
    });

    it('caps pageSize at 100 and falls back to defaults for junk', async () => {
      expect((await adm('get', '/api/admin/properties?pageSize=5000').expect(200)).body.pageSize).toBe(100);
      const junk = (await adm('get', '/api/admin/properties?page=abc&pageSize=xyz').expect(200)).body;
      expect([junk.page, junk.pageSize]).toEqual([1, 20]);
    });

    // BUG: a negative page/pageSize is passed through (parseInt('-5') is truthy), which
    // becomes a negative OFFSET/LIMIT in SQL. Should be clamped to >= 1.
    it.failing('BUG: clamps a negative page / pageSize to a sane value', async () => {
      const res = await adm('get', '/api/admin/properties?page=-5&pageSize=-5').expect(200);
      expect(res.body.page).toBeGreaterThanOrEqual(1);
      expect(res.body.pageSize).toBeGreaterThanOrEqual(1);
    });
  });

  /* ── walkthrough url ────────────────────────────────────────────────── */

  describe('GET /properties/:id/walkthrough-url', () => {
    it('returns a signed URL for a video in the listing-media bucket', async () => {
      const res = await adm('get', '/api/admin/properties/L1/walkthrough-url').expect(200);
      expect(res.body).toEqual({ url: 'https://signed.test/listing-media/host1/w.mp4' });
    });
    it('returns an outside URL as-is', async () => {
      listings[0].draft_data.telemetry.walkthroughVideoUrl = 'https://cdn.example.com/w.mp4';
      expect((await adm('get', '/api/admin/properties/L1/walkthrough-url').expect(200)).body).toEqual({ url: 'https://cdn.example.com/w.mp4' });
    });
    it('404 for an unknown listing', async () => {
      expectError(await adm('get', '/api/admin/properties/zzz/walkthrough-url'), 404, 'Listing not found');
    });
    it('404 when there is no video on file', async () => {
      expectError(await adm('get', '/api/admin/properties/L2/walkthrough-url'), 404, /no walkthrough video on file/);
    });
    it('404 when the file cannot be signed (not in storage)', async () => {
      listings[0].draft_data.telemetry.walkthroughVideoUrl = 'https://p.co/storage/listing-media/gone.mp4';
      expectError(await adm('get', '/api/admin/properties/L1/walkthrough-url'), 404, /not found in storage/);
    });
  });

  /* ── review decision ────────────────────────────────────────────────── */

  describe('PATCH /properties/:id', () => {
    const patch = (id: string, body: any) => adm('patch', `/api/admin/properties/${id}`).send(body);

    it('400 for an empty body, a bad status (incl. draft), and nothing-to-update', async () => {
      expectError(await patch('L1', {}), 400, 'Nothing to update');
      expectError(await patch('L1', { status: 'draft' }), 400);
      expectError(await patch('L1', { status: 'banana' }), 400);
      expectError(await patch('L1', { reviewNotes: 123 }), 400);
      expectError(await patch('L1', { reviewReasonCategory: 'whatever', reviewNotes: 'x' }), 400);
      expect(listings[0].status).toBe('in_review');
    });

    it('400 when rejecting / requesting changes without a category and an explanation', async () => {
      for (const status of ['rejected', 'changes_needed']) {
        expectError(await patch('L1', { status }), 400, /reason category and an explanation are required/);
        expectError(await patch('L1', { status, reviewReasonCategory: 'other' }), 400, /required/);
        expectError(await patch('L1', { status, reviewNotes: 'bad photos' }), 400, /required/);
      }
    });

    it('400 for an override with a too-short reason', async () => {
      expectError(await patch('L1', { status: 'live', overrideChecks: true, overrideReason: 'short' }), 400, /at least 10 characters/);
    });

    it('404 for an unknown listing', async () => {
      expectError(await patch('zzz', { status: 'paused' }), 404, 'Listing not found');
    });

    it('409 when going live while banking has not passed; nothing changes', async () => {
      profiles.find((p) => p.id === 'host1')!.bank_verified_at = null;
      const res = await patch('L1', { status: 'live' });
      expectError(res, 409, /Cannot approve yet: Banking is submitted/);
      expect(listings[0].status).toBe('in_review');
      expect(notified).toHaveLength(0);
    });

    it('409 when camera capture has not passed (legacy listing)', async () => {
      const res = await patch('L2', { status: 'live', overrideChecks: false });
      expectError(res, 409, /Camera capture is not started/);
    });

    it('approves a clear listing: live, notifies the host, bumps the search cache, hides draft_data', async () => {
      vreqs.find((r) => r.id === 'V1')!.status = 'verified';
      const res = await patch('L1', { status: 'live' }).expect(200);
      expect(res.body).toMatchObject({ success: true, message: 'Listing approved and published.', listing: { id: 'L1', status: 'live', reviewed_by: 'admin1' } });
      expect(res.body.listing.draft_data).toBeUndefined();
      expect(cacheBumps).toBe(1);
      expect(notified[0].slice(0, 2)).toEqual(['listing.live', 'host1']);
    });

    it('approves with unmet checks only with a reasoned override, and records it', async () => {
      const res = await patch('L2', { status: 'live', overrideChecks: true, overrideReason: 'Inspected in person by ops.' }).expect(200);
      expect(res.body.message).toBe('Listing approved and published.');
      expect(listings[1].draft_data.approval_overrides).toHaveLength(1);
      expect(listings[1].draft_data.approval_overrides[0]).toMatchObject({ adminId: 'admin1', reason: 'Inspected in person by ops.', previousStatus: 'live' });
    });

    it('requests changes with a category and notes; notifies host; no cache bump', async () => {
      const res = await patch('L1', { status: 'changes_needed', reviewReasonCategory: 'listing_content', reviewNotes: 'Add a kitchen photo' }).expect(200);
      expect(res.body).toMatchObject({ message: 'Changes requested from the host.', listing: { status: 'changes_needed', review_notes: 'Add a kitchen photo', review_reason_category: 'listing_content' } });
      expect(notified[0][0]).toBe('listing.changes_needed');
      expect(cacheBumps).toBe(0);
    });

    it('rejects, pauses (leaving live bumps the cache), and moves back to review', async () => {
      expect((await patch('L1', { status: 'rejected', reviewReasonCategory: 'other', reviewNotes: 'Fake photos' }).expect(200)).body.message).toBe('Listing rejected.');
      const paused = await patch('L2', { status: 'paused' }).expect(200);
      expect(paused.body).toMatchObject({ message: 'Listing paused.', listing: { status: 'paused' } });
      expect(cacheBumps).toBe(1);
      expect((await patch('L1', { status: 'in_review' }).expect(200)).body.message).toBe('Listing moved back to review.');
    });

    it('notes-only and markVisitPassed updates use their own messages', async () => {
      const notes = await patch('L1', { reviewNotes: 'Looks fine so far' }).expect(200);
      expect(notes.body).toMatchObject({ message: 'Listing updated.', listing: { status: 'in_review', review_notes: 'Looks fine so far' } });
      const visit = await patch('L1', { markVisitPassed: true }).expect(200);
      expect(visit.body).toMatchObject({ message: 'Site visit marked as passed.', listing: { visit_status: 'passed' } });
    });
  });

  /* ── stats ───────────────────────────────────────────────────────── */

  it('GET /stats returns the dashboard figures', async () => {
    const res = await adm('get', '/api/admin/stats').expect(200);
    expect(res.body.stats).toEqual({
      totalProperties: 3,
      pendingReviews: 1,
      liveProperties: 1,
      changesNeeded: 0,
      draftProperties: 1,
      totalUsers: 4,
      geoLock: { passed: 1, total: 2 },
      bankVerified: { verified: 1, total: 2 },
    });
  });

  /* ── users ───────────────────────────────────────────────────────── */

  describe('GET /users', () => {
    it('lists users with flags, listing counts, kyc status and counts', async () => {
      // kyc 'verified' = approved identity + selfie (the shared gate), not bank/PAN.
      vreqs.push({ id: 'V6', user_id: 'host1', verification_type: 'identity', status: 'verified', submitted_at: new Date('2026-03-01'), reviewed_by: 'admin1' });
      const res = await adm('get', '/api/admin/users').expect(200);
      expect(res.body).toMatchObject({ total: 4, page: 1, pageSize: 20, counts: { all: 4, hosts: 2, admins: 1, guests: 1 } });
      const host = res.body.users.find((u: any) => u.id === 'host1');
      expect(host).toMatchObject({ name: 'Hema Host', isHost: true, isAdmin: false, propertiesCount: 2, kycStatus: 'verified' });
      expect(res.body.users.find((u: any) => u.id === 'admin1').isAdmin).toBe(true);
      // host2 has a selfie and bank but no verified identity -> not KYC-verified.
      expect(res.body.users.find((u: any) => u.id === 'host2').kycStatus).toBe('not_submitted');
    });
    it('kycStatus follows the NEWEST identity request, not an older verified one', async () => {
      vreqs.push({ id: 'V6', user_id: 'host1', verification_type: 'identity', status: 'verified', submitted_at: new Date('2026-03-01'), reviewed_by: 'admin1' });
      vreqs.push({ id: 'V7', user_id: 'host1', verification_type: 'identity', status: 'rejected', submitted_at: new Date('2026-04-01'), reviewed_by: 'admin1' });
      const res = await adm('get', '/api/admin/users').expect(200);
      expect(res.body.users.find((u: any) => u.id === 'host1').kycStatus).toBe('not_submitted');
    });
    it('filters by role', async () => {
      const ids = async (r: string) => (await adm('get', `/api/admin/users?role=${r}`).expect(200)).body.users.map((u: any) => u.id).sort();
      expect(await ids('host')).toEqual(['host1', 'host2']);
      expect(await ids('admin')).toEqual(['admin1']);
      expect(await ids('guest')).toEqual(['guest1']);
    });
    it('searches name / email / phone', async () => {
      expect((await adm('get', '/api/admin/users?q=gita').expect(200)).body.users.map((u: any) => u.id)).toEqual(['guest1']);
      expect((await adm('get', '/api/admin/users?q=%2B911').expect(200)).body.users.map((u: any) => u.id)).toEqual(['host1']);
      expect((await adm('get', '/api/admin/users?q=nobody').expect(200)).body.total).toBe(0);
    });
    it('caps pageSize at 100', async () => {
      expect((await adm('get', '/api/admin/users?pageSize=999').expect(200)).body.pageSize).toBe(100);
    });
  });

  describe('PATCH /users/:id', () => {
    it('grants and revokes host access with matching messages', async () => {
      const on = await adm('patch', '/api/admin/users/guest1').send({ isHost: true }).expect(200);
      expect(on.body).toMatchObject({ success: true, message: 'User is now a host.', user: { id: 'guest1', isHost: true } });
      const off = await adm('patch', '/api/admin/users/guest1').send({ isHost: false }).expect(200);
      expect(off.body).toMatchObject({ message: 'Host access removed from this user.', user: { isHost: false } });
    });
    it('400 when isHost is missing or not a boolean', async () => {
      for (const body of [{}, { isHost: 'true' }, { isHost: 1 }, { isHost: null }]) {
        expectError(await adm('patch', '/api/admin/users/guest1').send(body), 400, 'isHost must be a boolean');
      }
      expect(profiles.find((p) => p.id === 'guest1')!.isHost).toBe(false);
    });
    it('404 for an unknown user', async () => {
      expectError(await adm('patch', '/api/admin/users/ghost').send({ isHost: true }), 404, 'User not found');
    });
  });

  /* ── payments ────────────────────────────────────────────────────── */

  describe('GET /payments', () => {
    it('lists the ledger joined with booking status', async () => {
      const res = await adm('get', '/api/admin/payments').expect(200);
      expect(res.body.total).toBe(2);
      expect(res.body.payments[0]).toMatchObject({ id: 'pay1', bookingId: 'B1', bookingStatus: 'disputed', amount: 5000, status: 'paid', cashfreeOrderId: 'o1' });
    });
    it('filters by status; unknown status gives an empty list', async () => {
      expect((await adm('get', '/api/admin/payments?status=refunded').expect(200)).body.payments.map((p: any) => p.id)).toEqual(['pay2']);
      expect((await adm('get', '/api/admin/payments?status=weird').expect(200)).body).toEqual({ payments: [], total: 0 });
    });
  });

  /* ── disputes ────────────────────────────────────────────────────── */

  describe('disputes', () => {
    it('GET /disputes lists disputed bookings only', async () => {
      const res = await adm('get', '/api/admin/disputes').expect(200);
      expect(res.body.total).toBe(1);
      expect(res.body.disputes[0]).toMatchObject({ bookingId: 'B1', listingTitle: 'Sky Loft', guestName: 'Gita Guest', hostName: 'Other Host', reason: 'dirty', amount: 5000 });
    });
    it('GET /disputes is empty when nothing is disputed', async () => {
      bookings[0].status = 'confirmed';
      expect((await adm('get', '/api/admin/disputes').expect(200)).body).toEqual({ disputes: [], total: 0 });
    });
    it('GET /disputes/:bookingId delegates with the admin id; 404 passes through', async () => {
      expect((await adm('get', '/api/admin/disputes/B1').expect(200)).body).toEqual({ bookingId: 'B1', timeline: [] });
      expect(bookingCalls).toEqual([['case', 'admin1', 'B1']]);
      expectError(await adm('get', '/api/admin/disputes/nope'), 404, 'Booking not found');
    });

    describe.each([
      ['PATCH /disputes/:bookingId', '/api/admin/disputes/B1', 'resolve', 'Dispute resolved.'],
      ['PATCH /disputes/:bookingId/appeal', '/api/admin/disputes/B1/appeal', 'appeal', 'Appeal decided.'],
    ])('%s', (_n, url, kind, message) => {
      it('resolves with a validated amount and optional message', async () => {
        const res = await adm('patch', url).send({ amountToGuest: 2500, message: 'Split it' }).expect(200);
        expect(res.body).toMatchObject({ success: true, message, bookingId: 'B1', amountToGuest: 2500 });
        expect(bookingCalls).toEqual([[kind, 'admin1', 'B1', 2500, 'Split it']]);
      });
      it('accepts 0 (full release to host)', async () => {
        await adm('patch', url).send({ amountToGuest: 0 }).expect(200);
      });
      it('400 for invalid DTOs and never reaches the booking service', async () => {
        const bad: any[] = [{}, { amountToGuest: -1 }, { amountToGuest: 10.5 }, { amountToGuest: '100' }, { amountToGuest: null }, { amountToGuest: 1, message: 5 }, { amountToGuest: 1, message: 'x'.repeat(2001) }];
        for (const body of bad) expectError(await adm('patch', url).send(body), 400);
        expect(bookingCalls).toHaveLength(0);
      });
      it('surfaces 404 / 409 from the booking engine', async () => {
        bookingFail = new NotFoundException('Dispute case not found');
        expectError(await adm('patch', url).send({ amountToGuest: 1 }), 404, 'Dispute case not found');
        bookingFail = new ConflictException('This dispute is not escalated.');
        expectError(await adm('patch', url).send({ amountToGuest: 1 }), 409, 'This dispute is not escalated.');
      });
    });
  });

  /* ── verification ───────────────────────────────────────────────── */

  describe('GET /users/:id/verification', () => {
    it('groups requests by type with the newest as current and the rest as history', async () => {
      const res = await adm('get', '/api/admin/users/host1/verification').expect(200);
      expect(res.body.userId).toBe('host1');
      expect(res.body.types.map((t: any) => t.type)).toEqual(['identity', 'pan', 'bank', 'selfie']);
      const bank = res.body.types.find((t: any) => t.type === 'bank');
      expect(bank.current.id).toBe('V1');
      expect(bank.previousAttempts).toMatchObject([{ id: 'V0', status: 'rejected', rejectionReason: 'blurry', reviewedBy: 'Ops Admin' }]);
    });
    it('returns empty slots for a user with no requests', async () => {
      const res = await adm('get', '/api/admin/users/guest1/verification').expect(200);
      expect(res.body.types.every((t: any) => t.current === null && t.previousAttempts.length === 0)).toBe(true);
    });
  });

  describe('GET /verification/:id', () => {
    it('returns detail with signed URLs, bank block, history and audit log', async () => {
      vaudit.push({ id: 'a0', admin_id: 'admin1', action: 'rejected', previous_status: 'pending', new_status: 'rejected', created_at: new Date() });
      const res = await adm('get', '/api/admin/verification/V1').expect(200);
      expect(res.body).toMatchObject({
        id: 'V1',
        userName: 'Hema Host',
        verificationType: 'bank',
        status: 'pending',
        documentUrl: 'https://signed.test/verification-documents/host1/bank/a.jpg',
        documentBackUrl: null,
        bank: { ifsc: 'HDFC0001', accountHolderName: 'Hema Host' },
        previousAttempts: [{ id: 'V0', status: 'rejected' }],
        auditLog: [{ adminName: 'Ops Admin', newStatus: 'rejected' }],
      });
    });
    it('omits the bank block for non-bank types', async () => {
      expect((await adm('get', '/api/admin/verification/V2').expect(200)).body.bank).toBeUndefined();
    });
    it('404 for an unknown request', async () => {
      expectError(await adm('get', '/api/admin/verification/zzz'), 404, 'Verification request not found');
    });
  });

  describe('GET /verification/:id/document-url', () => {
    it('returns a signed URL', async () => {
      expect((await adm('get', '/api/admin/verification/V2/document-url').expect(200)).body).toEqual({ url: 'https://signed.test/verification-documents/host1/selfie/s.jpg' });
    });
    it('404 for unknown request and for a request without a document', async () => {
      expectError(await adm('get', '/api/admin/verification/zzz/document-url'), 404, 'Verification request not found');
      expectError(await adm('get', '/api/admin/verification/V3/document-url'), 404, 'This verification request has no document');
    });
  });

  describe('POST /verification/:id/review', () => {
    const review = (id: string, body: any) => adm('post', `/api/admin/verification/${id}/review`).send(body);

    it('approves a bank request: verified, profile bank gate flipped, audit row, host notified', async () => {
      profiles.find((p) => p.id === 'host1')!.bank_verified_at = null;
      const res = await review('V1', { decision: 'approve' }).expect(201);
      expect(res.body).toMatchObject({ success: true, message: 'Verification approved.', request: { id: 'V1', status: 'verified', reviewed_by: 'admin1', rejection_reason: null } });
      const host = profiles.find((p) => p.id === 'host1')!;
      expect(host.bank_verified_at).toBeInstanceOf(Date);
      expect(host.bank_account_name).toBe('Hema Host');
      expect(vaudit).toHaveLength(1);
      expect(vaudit[0]).toMatchObject({ verification_request_id: 'V1', action: 'approved', previous_status: 'pending', new_status: 'verified' });
      expect(notified[0].slice(0, 2)).toEqual(['verification.layer_passed', 'host1']);
    });

    it('approves a selfie request and sets selfie_uploaded_at', async () => {
      profiles.find((p) => p.id === 'host1')!.selfie_uploaded_at = null;
      await review('V2', { decision: 'approve' }).expect(201);
      expect(profiles.find((p) => p.id === 'host1')!.selfie_uploaded_at).toBeInstanceOf(Date);
    });

    it('rejects with a reason (trimmed), logs it, and does not touch the profile gate', async () => {
      const before = profiles.find((p) => p.id === 'host1')!.bank_verified_at;
      const res = await review('V1', { decision: 'reject', rejectionReason: '  Account name mismatch ' }).expect(201);
      expect(res.body).toMatchObject({ message: 'Verification rejected.', request: { status: 'rejected', rejection_reason: 'Account name mismatch' } });
      expect(vaudit[0]).toMatchObject({ action: 'rejected', new_status: 'rejected', rejection_reason: 'Account name mismatch' });
      expect(profiles.find((p) => p.id === 'host1')!.bank_verified_at).toBe(before);
      expect(notified[0][0]).toBe('verification.layer_failed');
    });

    it('400 for a missing/invalid decision, or a reject without a reason', async () => {
      expectError(await review('V1', {}), 400);
      expectError(await review('V1', { decision: 'maybe' }), 400);
      expectError(await review('V1', { decision: 'reject' }), 400, 'A rejection reason is required to reject a verification request.');
      expectError(await review('V1', { decision: 'reject', rejectionReason: '   ' }), 400, /rejection reason is required/);
      expectError(await review('V1', { decision: 'reject', rejectionReason: 'x'.repeat(2001) }), 400);
      expect(vreqs.find((r) => r.id === 'V1')!.status).toBe('pending');
    });

    it('404 for an unknown request', async () => {
      expectError(await review('zzz', { decision: 'approve' }), 404, 'Verification request not found');
    });

    // Regression: in AADHAAR_VERIFICATION_MODE=admin an Aadhaar upload is a pending
    // 'identity' row, and the shared KYC gate needs it approved — an admin must be
    // able to approve or reject it (it used to 409, leaving every user stuck).
    it('approves a pending identity (Aadhaar) request: verified, audit row', async () => {
      const res = await review('V4', { decision: 'approve' }).expect(201);
      expect(vreqs.find((r) => r.id === 'V4')).toMatchObject({ status: 'verified', reviewed_by: 'admin1' });
      expect(vaudit).toHaveLength(1);
      expect(res.body.success).toBe(true);
    });

    it('rejects a pending identity request with a reason, and requires the reason', async () => {
      expectError(await review('V4', { decision: 'reject' }), 400);
      await review('V4', { decision: 'reject', rejectionReason: 'Back side is blurry' }).expect(201);
      expect(vreqs.find((r) => r.id === 'V4')).toMatchObject({ status: 'rejected', rejection_reason: 'Back side is blurry' });
    });

    it('409 when the request was already reviewed (state machine is one-way)', async () => {
      await review('V1', { decision: 'approve' }).expect(201);
      expectError(await review('V1', { decision: 'reject', rejectionReason: 'changed my mind' }), 409, /already been reviewed \(status: verified\)/);
      expect(vaudit).toHaveLength(1);
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 *  HOST LISTINGS
 * ══════════════════════════════════════════════════════════════════════ */

describe('Host listings API (/api/host/listings)', () => {
  let app: INestApplication;
  let listings: Row[];
  let profiles: Row[];
  let redisStore: Map<string, string>;
  let versionBumps: number;
  let verificationStatus: { identity: { status: string }; pan: { status: string }; bank: { status: string } };
  let captureConfig: { locationBypass: boolean };

  const PIN = { lat: 32.2701, lng: 77.1755 }; // Manali
  const TOKEN = '3b2d1623-b9fd-42f0-984e-97ef53a95a9f';
  const photoUrls = Array.from({ length: 5 }, (_, i) => `https://storage.test/host1/p${i}.jpg`);
  const hash = (u: string) => createHash('sha256').update(u).digest('hex');
  const captureRec = (kind: 'photo' | 'video', over: Row = {}) => ({ kind, lat: PIN.lat, lng: PIN.lng, accuracyM: 10, capturedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), distanceFromPinM: 3, source: 'device_reported', ...over });
  const seedWalkthrough = (userId = 'host1', tok = TOKEN, pin = PIN) =>
    redisStore.set(`walkthrough-token:${userId}:${tok}`, JSON.stringify({ lat: pin.lat, lng: pin.lng, videoUrl: 'https://storage.test/host1/w.mp4', check: { method: 'camera_captured', passed: true, capture: captureRec('video', { lat: pin.lat, lng: pin.lng }) } }));
  const seedPhotos = (userId = 'host1', urls = photoUrls, over: Row = {}) => urls.forEach((u) => redisStore.set(`capture-receipt:${userId}:${hash(u)}`, JSON.stringify(captureRec('photo', over))));

  const body = (over: Row = {}) => ({
    title: 'Deodar Nest Homestay',
    propertyType: 'house',
    placeType: 'entire',
    beds: '2BHK',
    bedrooms: 2,
    bathrooms: 1,
    maxGuests: 4,
    district: 'Kullu',
    tehsil: 'Manali',
    town: 'Manali',
    streetAddress: 'Near the old temple, Vashisht village',
    city: 'Manali',
    state: 'Himachal Pradesh',
    pincode: '175131',
    ...PIN,
    description: 'A quiet two-bedroom home with a deodar-lined balcony, let by the month. '.repeat(3),
    photos: photoUrls.map((url) => ({ url, room: 'exterior' })),
    dailyBaseRate: 1500,
    weeklyDiscountPct: 0,
    monthlyDiscountPct: 10,
    minDays: 30,
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
    walkthroughToken: TOKEN,
    ...over,
  });

  /** A listing row already saved by the host, with a stored walkthrough and legacy photos. */
  const stored = (over: Row = {}): Row => ({
    id: 'H1',
    host_id: 'host1',
    status: 'changes_needed',
    review_notes: 'Fix the photos',
    review_reason_category: 'listing_content',
    created_at: new Date('2026-03-01'),
    updated_at: new Date('2026-03-02'),
    draft_data: {
      property_details: { title: 'Old title', town: 'Manali', lat: PIN.lat, lng: PIN.lng, dailyBaseRate: 900, photos: photoUrls.map((url) => ({ url, room: 'exterior' })) },
      telemetry: { walkthroughPassed: true, status: 'needs_review' },
      media: { videoUrl: '' },
    },
    ...over,
  });

  beforeEach(async () => {
    listings = [];
    profiles = [{ ...USERS.host }, { ...USERS.other }, { ...USERS.guest }];
    redisStore = new Map();
    versionBumps = 0;
    verificationStatus = { identity: { status: 'verified' }, pan: { status: 'verified' }, bank: { status: 'verified' } };
    captureConfig = { locationBypass: false };

    const listingsRepo = makeRepo(listings);
    const moduleRef = await Test.createTestingModule({
      controllers: [HostListingsController],
      providers: [
        HostListingsService,
        { provide: CaptureConfigService, useValue: captureConfig },
        AuthGuard,
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: ConfigService, useValue: { get: (k: string) => ({ SUPABASE_JWT_SECRET: JWT_SECRET })[k] } },
        { provide: getRepositoryToken(ListingEntity), useValue: listingsRepo },
        { provide: getRepositoryToken(UserEntity), useValue: makeRepo(profiles) },
        { provide: getDataSourceToken(), useValue: { transaction: async (cb: any) => cb({ getRepository: () => listingsRepo }) } },
        { provide: VerificationService, useValue: { getMyStatus: async () => verificationStatus } },
        { provide: SupabaseProvider, useValue: { client: {} } },
        {
          provide: RedisService,
          useValue: {
            get: async (k: string) => redisStore.get(k) ?? null,
            set: async (k: string, v: string) => (redisStore.set(k, v), true),
            del: async (k: string) => void redisStore.delete(k),
            incrementVersion: async () => void versionBumps++,
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const api = () => request(app.getHttpServer());
  const host = (m: 'get' | 'post' | 'patch', url: string, who = 'host1') => api()[m](url).set('Cookie', as(who));
  const U = '/api/host/listings';

  /* ── auth on every route ─────────────────────────────────────────── */

  describe('authentication', () => {
    const routes: [string, string, string][] = [
      ['get', 'GET', U],
      ['post', 'POST', `${U}/submit-full`],
      ['post', 'POST', `${U}/save-draft`],
      ['get', 'GET', `${U}/draft`],
      ['post', 'POST', `${U}/media/video`],
      ['get', 'GET', `${U}/H1`],
      ['patch', 'PATCH', `${U}/H1`],
    ];
    it.each(routes)('%s %s %s -> 401 without a cookie, with a forged token, and when expired', async (m, _l, url) => {
      expectError(await (api() as any)[m](url).send({}), 401, 'No session cookie found');
      expectError(await (api() as any)[m](url).set('Cookie', `${SESSION_COOKIE}=${jwt.sign({ sub: 'host1' }, 'nope')}`).send({}), 401, 'Invalid or expired session');
      expectError(await (api() as any)[m](url).set('Cookie', `${SESSION_COOKIE}=${token('host1', { expiresIn: -5 })}`).send({}), 401, 'Session expired');
    });
  });

  /* ── GET / ───────────────────────────────────────────────────────── */

  describe('GET /', () => {
    it('returns an empty list for a new host', async () => {
      expect((await host('get', U).expect(200)).body).toEqual({ success: true, listings: [] });
    });
    it('returns only the caller\'s listings, flattened, newest first', async () => {
      listings.push(stored(), stored({ id: 'H2', status: 'live', created_at: new Date('2026-04-01') }), stored({ id: 'X1', host_id: 'host2' }));
      const res = await host('get', U).expect(200);
      expect(res.body.listings.map((l: any) => l.id)).toEqual(['H2', 'H1']);
      expect(res.body.listings[1]).toMatchObject({ status: 'changes_needed', title: 'Old title', town: 'Manali', dailyBaseRate: 900, photoCount: 0, coverPhotoUrl: photoUrls[0], reviewNotes: 'Fix the photos', reviewReasonCategory: 'listing_content' });
      expect(res.body.listings[0].draft_data).toBeUndefined();
    });
  });

  /* ── GET /draft ──────────────────────────────────────────────────── */

  describe('GET /draft', () => {
    it('returns null listing when there is no draft', async () => {
      listings.push(stored()); // changes_needed is not a resumable draft
      expect((await host('get', `${U}/draft`).expect(200)).body).toEqual({ success: true, listing: null });
    });
    it('returns the most recent draft, flattened', async () => {
      listings.push(stored({ id: 'D1', status: 'draft', updated_at: new Date('2026-03-01') }), stored({ id: 'D2', status: 'draft', updated_at: new Date('2026-05-01') }));
      const res = await host('get', `${U}/draft`).expect(200);
      expect(res.body.listing).toMatchObject({ id: 'D2', draft: { title: 'Old title', walkthroughPassed: true } });
    });
    it('?listingId fetches that exact draft; another host\'s or non-draft id gives null', async () => {
      listings.push(stored({ id: 'D1', status: 'draft' }), stored({ id: 'D2', status: 'draft', updated_at: new Date('2027-01-01') }), stored({ id: 'XD', status: 'draft', host_id: 'host2' }));
      expect((await host('get', `${U}/draft?listingId=D1`).expect(200)).body.listing.id).toBe('D1');
      expect((await host('get', `${U}/draft?listingId=XD`).expect(200)).body.listing).toBeNull();
      expect((await host('get', `${U}/draft?listingId=nope`).expect(200)).body.listing).toBeNull();
    });
  });

  /* ── GET /:id ───────────────────────────────────────────────────── */

  describe('GET /:id', () => {
    it('returns the caller\'s listing with a merged draft for prefilling', async () => {
      listings.push(stored());
      const res = await host('get', `${U}/H1`).expect(200);
      expect(res.body).toMatchObject({ success: true, listing: { id: 'H1', status: 'changes_needed', reviewNotes: 'Fix the photos', draft: { title: 'Old title', dailyBaseRate: 900, walkthroughPassed: true } } });
    });
    it('404 for an unknown id and for another host\'s listing (not 403: existence is not leaked)', async () => {
      listings.push(stored({ id: 'X1', host_id: 'host2' }));
      expectError(await host('get', `${U}/nope`), 404, 'Listing not found');
      expectError(await host('get', `${U}/X1`), 404, 'Listing not found');
    });
    it('does not swallow the static routes (draft is not an :id)', async () => {
      expect((await host('get', `${U}/draft`).expect(200)).body).toHaveProperty('listing');
    });
  });

  /* ── POST /media/video ─────────────────────────────────────────── */

  describe('POST /media/video', () => {
    it('always 400s with the "no longer supported" message', async () => {
      expectError(await host('post', `${U}/media/video`), 400, /Property videos can no longer be uploaded/);
    });
  });

  /* ── POST /save-draft ───────────────────────────────────────────── */

  describe('POST /save-draft', () => {
    it('creates a draft from a partial body, with no completeness requirement', async () => {
      const res = await host('post', `${U}/save-draft`).send({ title: 'Half done', dailyBaseRate: 1200, streetAddress: '' }).expect(201);
      expect(res.body).toMatchObject({ success: true, message: 'Draft saved.', status: 'draft', listingId: expect.any(String) });
      expect(listings).toHaveLength(1);
      expect(listings[0]).toMatchObject({ host_id: 'host1', status: 'draft' });
      expect(listings[0].draft_data.property_details).toMatchObject({ title: 'Half done', dailyBaseRate: 1200 });
      expect(listings[0].draft_data.property_details.streetAddress).toBeUndefined();
      expect(listings[0].draft_data.identity).toEqual({ pan: 'ABCDE1234F', gst: '' });
    });

    it('accepts an empty body and creates a blank draft', async () => {
      await host('post', `${U}/save-draft`).send({}).expect(201);
      expect(listings).toHaveLength(1);
    });

    it('reuses the row when listingId is echoed back (no fork) and merges fields', async () => {
      const first = await host('post', `${U}/save-draft`).send({ title: 'First title' }).expect(201);
      const second = await host('post', `${U}/save-draft`).send({ listingId: first.body.listingId, dailyBaseRate: 2000 }).expect(201);
      expect(second.body.listingId).toBe(first.body.listingId);
      expect(listings).toHaveLength(1);
      expect(listings[0].draft_data.property_details).toMatchObject({ title: 'First title', dailyBaseRate: 2000 });
    });

    it('400 when a provided field is invalid', async () => {
      expectError(await host('post', `${U}/save-draft`).send({ dailyBaseRate: 10 }), 400, /at least ₹500/);
      expectError(await host('post', `${U}/save-draft`).send({ title: 'abc' }), 400, /at least 4 characters/);
      expectError(await host('post', `${U}/save-draft`).send({ state: 'Punjab' }), 400);
      expect(listings).toHaveLength(0);
    });

    it('never stores a client-supplied walkthroughPassed as telemetry', async () => {
      await host('post', `${U}/save-draft`).send({ title: 'Sneaky one', walkthroughPassed: true }).expect(201);
      expect(listings[0].draft_data.telemetry).toEqual({});
    });

    it('stores a valid walkthrough receipt\'s telemetry without spending the token', async () => {
      seedWalkthrough();
      await host('post', `${U}/save-draft`).send({ title: 'With video', walkthroughToken: TOKEN, ...PIN }).expect(201);
      expect(listings[0].draft_data.telemetry).toMatchObject({ walkthroughPassed: true, status: 'needs_review' });
      expect(redisStore.has(`walkthrough-token:host1:${TOKEN}`)).toBe(true);
    });

    it('400 for a photo that was not taken with the in-app camera; accepts one with a receipt', async () => {
      const url = 'https://evil.example.com/stock.jpg';
      expectError(await host('post', `${U}/save-draft`).send({ photos: [{ url, room: 'living' }] }), 400, /Photo 1 is not a photo taken with the in-app camera/);
      seedPhotos('host1', [url]);
      await host('post', `${U}/save-draft`).send({ photos: [{ url, room: 'living' }] }).expect(201);
      expect(listings[0].draft_data.captures.photos[url]).toMatchObject({ source: 'device_reported' });
    });

    it('400 when adding a new property video URL', async () => {
      expectError(await host('post', `${U}/save-draft`).send({ videoUrl: 'https://x.test/v.mp4' }), 400, /property video can no longer be uploaded/);
    });

    it('404 for a listingId that does not exist or belongs to someone else', async () => {
      listings.push(stored({ id: 'X1', host_id: 'host2', status: 'draft' }));
      expectError(await host('post', `${U}/save-draft`).send({ listingId: 'nope', title: 'Whatever' }), 404, 'Listing not found');
      expectError(await host('post', `${U}/save-draft`).send({ listingId: 'X1', title: 'Hijack' }), 404, 'Listing not found');
      expect(listings[0].draft_data.property_details.title).toBe('Old title');
    });

    it('409 when the listing is in_review or paused', async () => {
      listings.push(stored({ id: 'R1', status: 'in_review' }), stored({ id: 'P1', status: 'paused' }));
      expectError(await host('post', `${U}/save-draft`).send({ listingId: 'R1', title: 'Edit while reviewing' }), 409, 'This listing cannot be saved as a draft right now.');
      expectError(await host('post', `${U}/save-draft`).send({ listingId: 'P1', title: 'Edit while paused' }), 409, /cannot be saved as a draft/);
    });

    it('keeps changes_needed status on save, but pulls a live listing back to in_review and busts the cache', async () => {
      listings.push(stored({ id: 'C1' }), stored({ id: 'LV', status: 'live' }));
      expect((await host('post', `${U}/save-draft`).send({ listingId: 'C1', title: 'Better title' }).expect(201)).body.status).toBe('changes_needed');
      expect(versionBumps).toBe(0);
      const live = await host('post', `${U}/save-draft`).send({ listingId: 'LV', title: 'Edited live' }).expect(201);
      expect(live.body.status).toBe('in_review');
      expect(versionBumps).toBe(1);
    });

    it('404 when the caller has no profile', async () => {
      expectError(await host('post', `${U}/save-draft`, 'ghost').send({}), 404, 'Profile not found');
    });
  });

  /* ── POST /submit-full ──────────────────────────────────────────── */

  describe('POST /submit-full', () => {
    const ready = () => (seedWalkthrough(), seedPhotos());

    it('creates an in_review listing, spends the walkthrough token, and stamps identity from the profile', async () => {
      ready();
      const res = await host('post', `${U}/submit-full`).send(body({ pan: 'ZZZZZ9999Z' })).expect(201);
      expect(res.body).toMatchObject({ success: true, message: 'Listing submitted for review.', status: 'in_review', listingId: expect.any(String) });
      expect(listings).toHaveLength(1);
      const row = listings[0];
      expect(row).toMatchObject({ host_id: 'host1', status: 'in_review' });
      expect(row.draft_data.identity.pan).toBe('ABCDE1234F');
      expect(row.draft_data.property_details).toMatchObject({ title: 'Deodar Nest Homestay', town: 'Manali', dailyBaseRate: 1500 });
      expect(row.draft_data.telemetry).toMatchObject({ walkthroughPassed: true, walkthroughVideoUrl: 'https://storage.test/host1/w.mp4', status: 'needs_review' });
      expect(Object.keys(row.draft_data.captures.photos)).toHaveLength(5);
      expect(redisStore.has(`walkthrough-token:host1:${TOKEN}`)).toBe(false);
    });

    it('replaying the same token is refused (single use)', async () => {
      ready();
      await host('post', `${U}/submit-full`).send(body()).expect(201);
      expectError(await host('post', `${U}/submit-full`).send(body()), 400, /expired or was already used/);
      expect(listings).toHaveLength(1);
    });

    it('promotes the caller\'s own saved draft instead of creating a second row', async () => {
      ready();
      listings.push(stored({ id: 'D1', status: 'draft' }));
      const res = await host('post', `${U}/submit-full`).send({ ...body(), listingId: 'D1' }).expect(201);
      expect(res.body.listingId).toBe('D1');
      expect(listings).toHaveLength(1);
      expect(listings[0].status).toBe('in_review');
    });

    it('does not overwrite another host\'s draft or a non-draft row: a fresh row is created', async () => {
      ready();
      listings.push(stored({ id: 'X1', host_id: 'host2', status: 'draft' }), stored({ id: 'LV', status: 'live' }));
      const a = await host('post', `${U}/submit-full`).send({ ...body(), listingId: 'X1' }).expect(201);
      expect(a.body.listingId).not.toBe('X1');
      expect(listings.find((l) => l.id === 'X1')).toMatchObject({ host_id: 'host2', status: 'draft' });
      seedWalkthrough();
      const b = await host('post', `${U}/submit-full`).send({ ...body(), listingId: 'LV' }).expect(201);
      expect(b.body.listingId).not.toBe('LV');
      expect(listings.find((l) => l.id === 'LV')!.status).toBe('live');
    });

    it('400 for an empty body and for each invalid field, with the first message', async () => {
      ready();
      expectError(await host('post', `${U}/submit-full`).send({}), 400);
      const cases: [Row, RegExp][] = [
        [{ title: 'abc' }, /at least 4 characters/],
        [{ dailyBaseRate: 100 }, /at least ₹500/],
        [{ photos: body().photos.slice(0, 3) }, /at least 5 photographs/],
        [{ description: 'too short' }, /at least 120 characters/],
        [{ pincode: '12' }, /6-digit PIN/],
        [{ amenities: ['Wifi'] }, /at least three amenities/],
        [{ propertyType: 'spaceship' }, /./],
        [{ state: 'Punjab' }, /./],
        [{ walkthroughPassed: false }, /Record the walkthrough video/],
        [{ lat: undefined }, /Drop the pin/],
        [{ walkthroughToken: 'not-a-uuid' }, /Record the walkthrough video again/],
      ];
      for (const [over, re] of cases) expectError(await host('post', `${U}/submit-full`).send(body(over)), 400, re);
      expect(listings).toHaveLength(0);
    });

    it('400 when the tehsil is not in the district, or the pin is outside Himachal', async () => {
      ready();
      expectError(await host('post', `${U}/submit-full`).send(body({ district: 'Kangra' })), 400, /belongs to Kangra district/);
      seedWalkthrough('host1', TOKEN, { lat: 30.7333, lng: 76.7794 });
      expectError(await host('post', `${U}/submit-full`).send(body({ lat: 30.7333, lng: 76.7794, district: 'Solan', tehsil: 'Parwanoo', town: 'Parwanoo' })), 400, /outside Himachal Pradesh/);
    });

    it('400 when no walkthrough token was ever issued / it expired / the pin moved far from it', async () => {
      seedPhotos();
      expectError(await host('post', `${U}/submit-full`).send(body()), 400, /expired or was already used/);
      expectError(await host('post', `${U}/submit-full`).send(body({ walkthroughToken: undefined })), 400, 'Record the walkthrough video with the camera before submitting.');
      seedWalkthrough('host1', TOKEN, { lat: 31.1, lng: 77.1 });
      expectError(await host('post', `${U}/submit-full`).send(body()), 400, /pin has moved since you recorded the walkthrough/);
      expect(listings).toHaveLength(0);
    });

    it('does not accept another host\'s walkthrough token', async () => {
      seedWalkthrough('host2');
      seedPhotos();
      expectError(await host('post', `${U}/submit-full`).send(body()), 400, /expired or was already used/);
    });

    it('400 when a photo has no capture receipt, or was captured too far from the pin', async () => {
      seedWalkthrough();
      expectError(await host('post', `${U}/submit-full`).send(body()), 400, /Photo 1 is not a photo taken with the in-app camera/);
      seedWalkthrough();
      seedPhotos('host1', photoUrls, { lat: 31.0, lng: 77.0 });
      expectError(await host('post', `${U}/submit-full`).send(body()), 400, /captured more than 200 m from the pin/);
      expect(listings).toHaveLength(0);
    });

    it('400 when sending a new property video URL', async () => {
      ready();
      expectError(await host('post', `${U}/submit-full`).send(body({ videoUrl: 'https://x.test/v.mp4' })), 400, /property video can no longer be uploaded/);
    });

    it('403 until identity and a live selfie are both verified (same gate as guests)', async () => {
      ready();
      verificationStatus.identity.status = 'pending';
      expectError(await host('post', `${U}/submit-full`).send(body()), 403, /Verify your identity/);
      verificationStatus.identity.status = 'verified';
      profiles[0].selfie_uploaded_at = null;
      expectError(await host('post', `${U}/submit-full`).send(body()), 403, /live selfie/);
      expect(listings).toHaveLength(0);
      expect(redisStore.has(`walkthrough-token:host1:${TOKEN}`)).toBe(true); // gate runs before the token is spent
    });

    it('bank and PAN are NOT part of the gate: identity + selfie alone are enough to submit', async () => {
      ready();
      verificationStatus.pan.status = 'rejected';
      verificationStatus.bank.status = 'not_started';
      await host('post', `${U}/submit-full`).send(body()).expect(201);
      expect(listings).toHaveLength(1);
    });

    describe('pin outside Himachal (Mohali), CAPTURE_LOCATION_BYPASS', () => {
      const MOHALI = { lat: 30.7046, lng: 76.7179 };
      const mohali = () => body({ ...MOHALI, district: 'Solan', tehsil: 'Parwanoo', town: 'Parwanoo' });
      const readyAt = () => (seedWalkthrough('host1', TOKEN, MOHALI), seedPhotos('host1', photoUrls, MOHALI));

      it('bypass OFF: refused as outside Himachal Pradesh, nothing stored', async () => {
        readyAt();
        expectError(await host('post', `${U}/submit-full`).send(mohali()), 400, /outside Himachal Pradesh/);
        expect(listings).toHaveLength(0);
      });

      it('bypass ON: the same submission is accepted and goes in_review', async () => {
        captureConfig.locationBypass = true;
        readyAt();
        const res = await host('post', `${U}/submit-full`).send(mohali()).expect(201);
        expect(res.body).toMatchObject({ success: true, status: 'in_review' });
        expect(listings[0].draft_data.property_details).toMatchObject({ lat: MOHALI.lat, lng: MOHALI.lng });
      });

      it('bypass ON does not relax the gate or the tehsil/district rule', async () => {
        captureConfig.locationBypass = true;
        readyAt();
        expectError(await host('post', `${U}/submit-full`).send({ ...mohali(), district: 'Kangra' }), 400, /belongs to Kangra district/);
        verificationStatus.identity.status = 'pending';
        expectError(await host('post', `${U}/submit-full`).send(mohali()), 403, /Verify your identity/);
      });
    });

    it('404 when the caller has no profile', async () => {
      expectError(await host('post', `${U}/submit-full`, 'ghost').send(body()), 404, 'Profile not found');
    });
  });

  /* ── PATCH /:id (resubmit) ───────────────────────────────────────── */

  describe('PATCH /:id', () => {
    const edit = (id: string, b: Row, who = 'host1') => host('patch', `${U}/${id}`, who).send(b);

    it('resubmits a changes_needed listing: in_review, review note cleared, stored walkthrough kept', async () => {
      listings.push(stored());
      const res = await edit('H1', body({ title: 'Brand new title', walkthroughToken: undefined })).expect(200);
      expect(res.body).toMatchObject({ success: true, message: 'Listing updated and sent for review.', listingId: 'H1', status: 'in_review' });
      expect(listings[0]).toMatchObject({ status: 'in_review', review_notes: null, review_reason_category: null });
      expect(listings[0].draft_data.property_details.title).toBe('Brand new title');
      expect(listings[0].draft_data.telemetry).toMatchObject({ walkthroughPassed: true });
      expect(versionBumps).toBe(0);
    });

    it('resubmits from rejected (stored walkthrough) and from draft (needs a fresh recording)', async () => {
      listings.push(stored({ id: 'D1', status: 'draft' }), stored({ id: 'R1', status: 'rejected' }));
      await edit('R1', body({ walkthroughToken: undefined })).expect(200);
      expectError(await edit('D1', body({ walkthroughToken: undefined })), 400, 'Record the walkthrough video with the camera before submitting.');
      seedWalkthrough();
      await edit('D1', body()).expect(200);
      expect(listings.map((l) => l.status)).toEqual(['in_review', 'in_review']);
    });

    it('editing a live listing pulls it to in_review and busts the search cache', async () => {
      listings.push(stored({ id: 'LV', status: 'live' }));
      await edit('LV', body({ walkthroughToken: undefined })).expect(200);
      expect(listings[0].status).toBe('in_review');
      expect(versionBumps).toBe(1);
    });

    it('uses a fresh walkthrough receipt when one is sent', async () => {
      listings.push(stored());
      seedWalkthrough();
      await edit('H1', body()).expect(200);
      expect(listings[0].draft_data.telemetry.walkthroughVideoUrl).toBe('https://storage.test/host1/w.mp4');
      expect(redisStore.has(`walkthrough-token:host1:${TOKEN}`)).toBe(false);
    });

    it('404 for an unknown listing and for another host\'s listing (which stays untouched)', async () => {
      listings.push(stored({ id: 'X1', host_id: 'host2' }));
      expectError(await edit('nope', body()), 404, 'Listing not found');
      expectError(await edit('X1', body()), 404, 'Listing not found');
      expect(listings[0]).toMatchObject({ status: 'changes_needed', host_id: 'host2' });
    });

    it('409 for in_review and paused listings', async () => {
      listings.push(stored({ id: 'R1', status: 'in_review' }), stored({ id: 'P1', status: 'paused' }));
      expectError(await edit('R1', body({ walkthroughToken: undefined })), 409, 'This listing cannot be edited right now.');
      expectError(await edit('P1', body({ walkthroughToken: undefined })), 409, 'This listing cannot be edited right now.');
      expect(listings.map((l) => l.status)).toEqual(['in_review', 'paused']);
    });

    it('400 for an invalid body and leaves the listing unchanged', async () => {
      listings.push(stored());
      expectError(await edit('H1', {}), 400);
      expectError(await edit('H1', body({ dailyBaseRate: 5 })), 400, /at least ₹500/);
      expectError(await edit('H1', body({ photos: [] })), 400, /at least 5 photographs/);
      expect(listings[0].status).toBe('changes_needed');
      expect(listings[0].review_notes).toBe('Fix the photos');
    });

    it('400 when the pin moved away from the stored walkthrough', async () => {
      listings.push(stored());
      expectError(await edit('H1', body({ lat: 32.5, lng: 77.5, walkthroughToken: undefined })), 400, /pin has moved since the walkthrough was recorded/);
      expect(listings[0].status).toBe('changes_needed');
    });

    it('400 when the listing has no stored walkthrough and no receipt is sent', async () => {
      listings.push(stored({ draft_data: { property_details: { photos: [] } } }));
      expectError(await edit('H1', body({ walkthroughToken: undefined })), 400, 'Record the walkthrough video with the camera before submitting.');
    });

    it('400 for a new photo with no capture receipt', async () => {
      listings.push(stored());
      const photos = [...body().photos.slice(0, 4), { url: 'https://evil.example.com/new.jpg', room: 'view' }];
      expectError(await edit('H1', body({ photos, walkthroughToken: undefined })), 400, /Photo 5 is not a photo taken with the in-app camera/);
    });
  });
});
