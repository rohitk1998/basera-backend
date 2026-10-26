import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { createHmac } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator, QueryFailedError } from 'typeorm';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { ResponseMessageInterceptor } from '../src/common/interceptors/response-message.interceptor';
import { AuthGuard, SESSION_COOKIE } from '../src/auth/auth.guard';
import { SupabaseProvider } from '../src/auth/supabase.provider';
import { BookingsController } from '../src/bookings/bookings.controller';
import { BookingsService } from '../src/bookings/bookings.service';
import { PaymentWebhookController } from '../src/bookings/payment-webhook.controller';
import { CashfreeService, PgOrder } from '../src/payments/cashfree.service';
import { PaymentsController } from '../src/payments/payments.controller';
import { PaymentsService } from '../src/payments/payments.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import {
  BookingEntity,
  BookingEventEntity,
  DisputeCaseEntity,
  DisputeEventEntity,
  ListingEntity,
  PaymentEntity,
  ReviewEntity,
  UserEntity,
  VerificationRequestEntity,
} from '../src/entities';

const SECRET = 'test-jwt-secret';
const GUEST = 'guest-1';
const HOST = 'host-1';
const STRANGER = 'stranger-1';
const LISTING_ID = '11111111-1111-4111-8111-111111111111';
const MISSING_ID = 'does-not-exist';
const PG_SECRET = 'test-pg-client-secret';

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const tokenFor = (sub: string, opts: jwt.SignOptions = {}) => jwt.sign({ sub }, SECRET, opts);
const as = (sub: string) => `${SESSION_COOKIE}=${tokenFor(sub)}`;

function makeRepo(rows: Record<string, any>[] = [], opts: { idPrefix?: string } = {}) {
  let seq = 0;
  const match = (r: any, where: any): boolean =>
    Array.isArray(where) ? where.some((w) => match(r, w)) : Object.entries(where ?? {}).every(([k, v]) => (v instanceof FindOperator ? (v.value as any[]).includes(r[k]) : r[k] === v));
  const sorted = (list: any[], order?: Record<string, 'ASC' | 'DESC'>) => {
    if (!order) return list;
    const [[key, dir]] = Object.entries(order);
    return [...list].sort((a, b) => ((a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : a.__seq - b.__seq) * (dir === 'DESC' ? -1 : 1)));
  };
  const withMeta = (r: any) => {
    r.id = r.id ?? `${opts.idPrefix ?? 'row'}-${++seq}`;
    r.__seq = r.__seq ?? ++seq;
    r.created_at = r.created_at ?? new Date(Date.now() + r.__seq);
    r.updated_at = r.updated_at ?? r.created_at;
    return r;
  };
  const repo = {
    rows,
    findOne: async ({ where, order }: any) => sorted(rows.filter((r) => match(r, where)), order)[0] ?? null,
    find: async ({ where, order }: any = {}) => sorted(rows.filter((r) => match(r, where)), order),
    findAndCount: async ({ where, order, take, skip }: any) => {
      const all = sorted(rows.filter((r) => match(r, where)), order);
      return [all.slice(skip ?? 0, (skip ?? 0) + (take ?? all.length)), all.length];
    },
    create: (x: any) => ({ ...x }),
    save: async (x: any) => {
      if (!rows.includes(x)) rows.push(withMeta(x));
      return x;
    },
    insert: async (x: any) => {
      const row = withMeta({ ...x });
      rows.push(row);
      return { identifiers: [{ id: row.id }] };
    },
    update: async (where: any, patch: any) => {
      const hit = rows.filter((r) => match(r, where));
      hit.forEach((r) => Object.assign(r, patch));
      return { affected: hit.length };
    },
    seed: (x: any) => {
      rows.push(withMeta(x));
      return x;
    },
  };
  return repo;
}

function buildStore() {
  const bookings = makeRepo([], { idPrefix: 'bk' });
  const events = makeRepo();
  const listings = makeRepo();
  const profiles = makeRepo();
  const verifications = makeRepo();
  const reviews = makeRepo();
  const cases = makeRepo([], { idPrefix: 'case' });
  const caseEvents = makeRepo();
  const payments = makeRepo([], { idPrefix: 'pay' });

  (bookings as any).createQueryBuilder = () => {
    const params: Record<string, any> = {};
    const qb: any = {
      where: (_s: string, p: any) => (Object.assign(params, p), qb),
      andWhere: (_s: string, p: any) => (Object.assign(params, p), qb),
      getOne: async () =>
        bookings.rows.find(
          (b) =>
            b.listing_id === params.listingId &&
            (params.statuses ? params.statuses.includes(b.status) : b.guest_id === params.userId && b.status === params.status) &&
            b.move_in < params.moveOut &&
            b.move_out > params.moveIn,
        ) ?? null,
    };
    return qb;
  };

  const repoByEntity = new Map<any, any>([
    [BookingEntity, bookings],
    [BookingEventEntity, events],
    [VerificationRequestEntity, verifications],
    [DisputeCaseEntity, cases],
    [DisputeEventEntity, caseEvents],
  ]);
  const dataSource = {
    getRepository: (entity: any) => repoByEntity.get(entity),
    transaction: async (cb: any) =>
      cb({
        update: (entity: any, where: any, patch: any) => repoByEntity.get(entity).update(where, patch),
        getRepository: (entity: any) => repoByEntity.get(entity),
      }),
    createQueryBuilder: () => {
      let whereSql = '';
      let userId = '';
      let hidden: string[] = [];
      const qb: any = {
        innerJoin: () => qb,
        leftJoin: () => qb,
        select: () => qb,
        orderBy: () => qb,
        where: (sql: string, p: any) => ((whereSql = sql), (userId = p.userId), qb),
        andWhere: (_sql: string, p: any) => ((hidden = p.unpaid), qb),
        getRawMany: async () =>
          payments.rows
            .filter((p) => !hidden.includes(p.status))
            .map((p) => ({ p, b: bookings.rows.find((b) => b.id === p.booking_id)! }))
            .filter(({ b }) =>
              whereSql.includes(' OR ') ? b.guest_id === userId || b.host_id === userId : whereSql.includes('guest_id') ? b.guest_id === userId : b.host_id === userId,
            )
            .map(({ p, b }) => ({
              id: p.id,
              amount: p.amount,
              status: p.status,
              cashfreeOrderId: p.cashfree_order_id,
              cashfreePayoutId: p.cashfree_payout_id,
              createdAt: p.created_at,
              updatedAt: p.updated_at,
              bookingId: b.id,
              moveIn: b.move_in,
              moveOut: b.move_out,
              listingTitle: listings.rows.find((l) => l.id === b.listing_id)?.draft_data?.property_details?.title,
            })),
      };
      return qb;
    },
  };

  const upload = jest.fn(async () => ({ error: null }));
  const supabase = {
    client: { storage: { from: () => ({ upload, getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }) }) } },
  };
  const notify = jest.fn();

  const orders = new Map<string, PgOrder>();
  const realCashfree = new CashfreeService({ get: (k: string) => ({ CASHFREE_PG_CLIENT_SECRET: PG_SECRET })[k] } as unknown as ConfigService);
  const cashfree = {
    checkoutMode: 'sandbox' as const,
    createPgOrder: jest.fn(async (p: { orderId: string; amount: number }) => {
      const order: PgOrder = { orderId: p.orderId, status: 'ACTIVE', amount: p.amount, currency: 'INR', paymentSessionId: `session_${p.orderId}` };
      orders.set(p.orderId, order);
      return order;
    }),
    fetchPgOrder: jest.fn(async (orderId: string) => orders.get(orderId) ?? null),
    fetchSuccessfulPaymentId: jest.fn(async () => 'cfpay-1'),
    verifyWebhookSignature: (raw: Buffer | string, sig?: string, ts?: string) => realCashfree.verifyWebhookSignature(raw, sig, ts),
  };

  listings.seed({ id: LISTING_ID, host_id: HOST, status: 'live', draft_data: { property_details: { title: 'Pine Cottage', dailyBaseRate: 1000, maxGuests: 4, minDays: 2 } } });
  profiles.seed({ id: GUEST, full_name: 'Gita Guest', phone: '+919876543210', selfie_uploaded_at: new Date() });
  verifications.seed({ user_id: GUEST, verification_type: 'identity', status: 'verified', submitted_at: new Date() });
  profiles.seed({ id: HOST, full_name: 'Hari Host' });

  return { bookings, events, listings, profiles, verifications, reviews, cases, caseEvents, payments, dataSource, supabase, upload, notify, orders, cashfree };
}

type Store = ReturnType<typeof buildStore>;

function seedBooking(s: Store, over: Record<string, any> = {}) {
  return s.bookings.seed({
    listing_id: LISTING_ID,
    guest_id: GUEST,
    host_id: HOST,
    status: 'requested',
    move_in: day(10),
    move_out: day(15),
    months: 5,
    adults: 1,
    children: 0,
    infants: 0,
    pets: 0,
    monthly_rent: 5000,
    deposit: 0,
    payment_method: 'upi',
    due_at_move_in: 5000,
    gross_booking_amount: 5000,
    platform_commission: 500,
    host_payout_amount: 4500,
    checkin_code: null,
    checkin_time: null,
    escrow_release_time: null,
    rejection_reason: null,
    ...over,
  });
}
const seedPayment = (s: Store, bookingId: string, over: Record<string, any> = {}) =>
  s.payments.seed({ booking_id: bookingId, amount: 5000, status: 'held', cashfree_order_id: 'SIMULATED-x', cashfree_payout_id: null, ...over });
const seedCase = (s: Store, bookingId: string, over: Record<string, any> = {}) =>
  s.cases.seed({ booking_id: bookingId, case_status: 'open', evidence_urls: [], negotiation_rounds: 0, appeal_used: false, requested_amount: 3000, ...over });
const seedCaseEvent = (s: Store, caseId: string, over: Record<string, any>) =>
  s.caseEvents.seed({ dispute_case_id: caseId, ...over });

describe('Bookings + Payments (HTTP, real controllers/services/AuthGuard, in-memory repos)', () => {
  let app: INestApplication;
  let s: Store;
  const api = () => request(app.getHttpServer());

  beforeEach(async () => {
    s = buildStore();
    const moduleRef = await Test.createTestingModule({
      controllers: [BookingsController, PaymentsController, PaymentWebhookController],
      providers: [
        BookingsService,
        PaymentsService,
        { provide: CashfreeService, useValue: s.cashfree },
        AuthGuard,
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: ConfigService, useValue: { get: (k: string) => ({ SUPABASE_JWT_SECRET: SECRET, PLATFORM_COMMISSION_PERCENTAGE: 10 })[k] } },
        { provide: NotificationsService, useValue: { notify: s.notify } },
        { provide: SupabaseProvider, useValue: s.supabase },
        { provide: getDataSourceToken(), useValue: s.dataSource },
        { provide: getRepositoryToken(BookingEntity), useValue: s.bookings },
        { provide: getRepositoryToken(BookingEventEntity), useValue: s.events },
        { provide: getRepositoryToken(ListingEntity), useValue: s.listings },
        { provide: getRepositoryToken(UserEntity), useValue: s.profiles },
        { provide: getRepositoryToken(ReviewEntity), useValue: s.reviews },
        { provide: getRepositoryToken(DisputeCaseEntity), useValue: s.cases },
        { provide: getRepositoryToken(DisputeEventEntity), useValue: s.caseEvents },
        { provide: getRepositoryToken(PaymentEntity), useValue: s.payments },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const expectError = (res: request.Response, status: number, msg?: RegExp) => {
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ success: false, statusCode: status });
    expect(typeof res.body.message).toBe('string');
    expect(res.body.error).toBe(res.body.message);
    if (msg) expect(res.body.message).toMatch(msg);
  };

  describe('authentication (real AuthGuard)', () => {
    const routes: [string, string][] = [
      ['post', '/api/bookings'],
      ['get', '/api/bookings'],
      ['get', '/api/bookings/x'],
      ['post', '/api/bookings/x/approve'],
      ['post', '/api/bookings/x/decline'],
      ['post', '/api/bookings/x/cancel'],
      ['post', '/api/bookings/x/pay'],
      ['get', '/api/bookings/x/payment'],
      ['post', '/api/bookings/x/checkin'],
      ['post', '/api/bookings/x/dispute'],
      ['get', '/api/bookings/x/dispute'],
      ['post', '/api/bookings/x/dispute/evidence'],
      ['post', '/api/bookings/x/dispute/offer'],
      ['post', '/api/bookings/x/dispute/respond'],
      ['post', '/api/bookings/x/dispute/appeal'],
      ['post', '/api/bookings/x/checkout'],
      ['get', '/api/transactions'],
    ];

    it.each(routes)('%s %s -> 401 without a session cookie', async (method, path) => {
      const res = await (api() as any)[method](path);
      expectError(res, 401, /No session cookie/);
    });

    it('401 for a token signed with the wrong secret', async () => {
      const bad = jwt.sign({ sub: GUEST }, 'other-secret');
      expectError(await api().get('/api/bookings').set('Cookie', `${SESSION_COOKIE}=${bad}`), 401, /Invalid or expired/);
    });

    it('401 for garbage in the cookie', async () => {
      expectError(await api().get('/api/transactions').set('Cookie', `${SESSION_COOKIE}=not-a-jwt`), 401);
    });

    it('401 with code session_expired semantics for an expired token', async () => {
      const res = await api().get('/api/bookings').set('Cookie', `${SESSION_COOKIE}=${tokenFor(GUEST, { expiresIn: -10 })}`);
      expectError(res, 401, /Session expired/);
    });

    it('401 for a valid token that has no subject', async () => {
      const res = await api().get('/api/bookings').set('Cookie', `${SESSION_COOKIE}=${jwt.sign({}, SECRET)}`);
      expectError(res, 401);
    });

    it('accepts the JSON-wrapped {access_token} cookie form', async () => {
      const wrapped = encodeURIComponent(JSON.stringify({ access_token: tokenFor(GUEST) }));
      const res = await api().get('/api/bookings').set('Cookie', `${SESSION_COOKIE}=${wrapped}`);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/bookings (create)', () => {
    const body = (over: Record<string, any> = {}) => ({ listingId: LISTING_ID, moveIn: day(10), moveOut: day(15), days: 5, paymentMethod: 'upi', ...over });
    const create = (b: any, user = GUEST) => api().post('/api/bookings').set('Cookie', as(user)).send(b);

    it('201: creates a requested booking, prices it server-side, notifies host', async () => {
      const res = await create(body());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, message: 'Booking request sent to the host.', status: 'requested' });
      expect(res.body.id).toBeTruthy();
      expect(Object.keys(res.body).slice(0, 2)).toEqual(['success', 'message']);

      const row = s.bookings.rows[0];
      expect(row).toMatchObject({ guest_id: GUEST, host_id: HOST, status: 'requested', monthly_rent: 5000, gross_booking_amount: 5000, platform_commission: 500, host_payout_amount: 4500, adults: 1, children: 0 });
      expect(s.events.rows[0]).toMatchObject({ from_status: null, to_status: 'requested', actor: GUEST });
      expect(s.notify).toHaveBeenCalledWith('booking.requested', HOST, expect.objectContaining({ listingTitle: 'Pine Cottage', guestName: 'Gita Guest' }));
    });

    it('ignores client-supplied price fields (whitelist) so a guest cannot set their own price', async () => {
      const res = await create(body({ monthly_rent: 1, totalRent: 1, host_payout_amount: 99999 }));
      expect(res.status).toBe(201);
      expect(s.bookings.rows[0].monthly_rent).toBe(5000);
      expect(s.bookings.rows[0].host_payout_amount).toBe(4500);
    });

    it.each([
      ['listingId not a uuid', { listingId: 'abc' }, /listingId must be a UUID/],
      ['missing moveIn', { moveIn: undefined }, /moveIn/],
      ['empty moveOut', { moveOut: '' }, /moveOut/],
      ['days is 0', { days: 0 }, /days must not be less than 1/],
      ['days > 730', { days: 731 }, /days must not be greater than 730/],
      ['days not an integer', { days: 2.5 }, /days must be an integer/],
      ['days is a string', { days: '5' }, /days must be an integer/],
      ['paymentMethod invalid', { paymentMethod: 'card' }, /paymentMethod must be one of/],
      ['adults is 0', { adults: 0 }, /adults must not be less than 1/],
      ['children negative', { children: -1 }, /children must not be less than 0/],
      ['pets not integer', { pets: 'x' }, /pets must be an integer/],
    ])('400 DTO validation: %s', async (_l, over, msg) => {
      const res = await create(body(over));
      expectError(res, 400, msg);
      expect(Array.isArray(res.body.errors)).toBe(true);
      expect(s.bookings.rows).toHaveLength(0);
    });

    it('400 for an empty body, listing every violation', async () => {
      const res = await create({});
      expectError(res, 400);
      expect(res.body.errors.length).toBeGreaterThanOrEqual(5);
    });

    it('400 for an unparseable date', async () => {
      expectError(await create(body({ moveIn: 'garbage' })), 400, /Invalid date format/);
    });
    it('400 for a move-in date in the past', async () => {
      expectError(await create(body({ moveIn: day(-3), moveOut: day(2) })), 400, /in the past/);
    });
    it('400 when move-out is not after move-in', async () => {
      expectError(await create(body({ moveIn: day(10), moveOut: day(10) })), 400, /after move-in/);
    });
    it('400 when party size exceeds the listing capacity', async () => {
      expectError(await create(body({ adults: 3, children: 2 })), 400, /sleeps up to 4 guests/);
    });
    it('400 when the stay is shorter than the listing minimum', async () => {
      expectError(await create(body({ moveOut: day(11), days: 1 })), 400, /minimum stay of 2 days/);
    });

    it('404 for an unknown listing', async () => {
      expectError(await create(body({ listingId: '22222222-2222-4222-8222-222222222222' })), 404, /Listing not found/);
    });
    it('400 when the listing is not live', async () => {
      s.listings.rows[0].status = 'draft';
      expectError(await create(body()), 400, /not open for booking/);
    });
    it('403 when booking your own listing', async () => {
      expectError(await create(body(), HOST), 403, /own property/);
    });
    it('403 when acting in host mode', async () => {
      expectError(await create(body({ role: 'host' })), 403, /switch to guest mode/);
    });

    it('409 double-booking: overlaps a confirmed booking by someone else', async () => {
      seedBooking(s, { guest_id: STRANGER, status: 'confirmed', move_in: day(12), move_out: day(20) });
      const res = await create(body());
      expectError(res, 409, /not available for the selected dates/);
      expect(s.bookings.rows).toHaveLength(1);
    });
    it('201: adjacent (non-overlapping) dates are not a conflict', async () => {
      seedBooking(s, { guest_id: STRANGER, status: 'confirmed', move_in: day(15), move_out: day(20) });
      expect((await create(body())).status).toBe(201);
    });
    it('201: a merely requested booking by someone else does not block the dates', async () => {
      seedBooking(s, { guest_id: STRANGER, status: 'requested' });
      expect((await create(body())).status).toBe(201);
    });
    it('409: duplicate pending request by the same guest for overlapping dates', async () => {
      expect((await create(body())).status).toBe(201);
      expectError(await create(body({ moveIn: day(12), moveOut: day(18), days: 6 })), 409, /already have a pending request/);
    });

    it('500 with a generic message (no driver leak) when the insert fails', async () => {
      s.bookings.insert = async () => {
        throw new Error('relation "bookings" secret detail');
      };
      const res = await create(body());
      expectError(res, 500, /Could not create the booking/);
      expect(res.body.message).not.toMatch(/secret detail/);
    });

    it('201: books with a verified identity and a live selfie, with no bank or PAN on file', async () => {
      const res = await create(body());
      expect(res.status).toBe(201);
    });

    it('403 when the guest has not taken a live selfie', async () => {
      Object.assign(s.profiles.rows.find((p) => p.id === GUEST)!, { selfie_uploaded_at: null });
      const res = await create(body());
      expectError(res, 403, /live selfie/i);
    });

    it.each(['pending', 'rejected'])('403 when the latest identity document is %s', async (status) => {
      s.verifications.rows.length = 0;
      s.verifications.seed({ user_id: GUEST, verification_type: 'identity', status, submitted_at: new Date() });
      const res = await create(body());
      expectError(res, 403, /identity/i);
    });

    it('403 when no identity document was ever submitted', async () => {
      s.verifications.rows.length = 0;
      const res = await create(body());
      expectError(res, 403, /identity/i);
    });

    it('uses the NEWEST identity request (an older verified one does not count after a rejected resubmission)', async () => {
      s.verifications.seed({ user_id: GUEST, verification_type: 'identity', status: 'rejected', submitted_at: new Date(Date.now() + 60_000) });
      const res = await create(body());
      expectError(res, 403, /identity/i);
    });
  });

  describe('GET /api/bookings (list)', () => {
    const list = (q = '', user = GUEST) => api().get(`/api/bookings${q}`).set('Cookie', as(user));

    it('200: defaults to the guest view, flattened and paginated, GET not wrapped with a message', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      seedPayment(s, b.id);
      seedBooking(s, { guest_id: STRANGER });
      const res = await list();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        bookings: [expect.objectContaining({ id: b.id, listingTitle: 'Pine Cottage', status: 'confirmed', isPaid: true, hasReviewed: false, counterpartName: 'Hari Host', totalRent: 5000 })],
        page: 1,
        pageSize: 20,
        total: 1,
      });
      expect(res.body.message).toBeUndefined();
    });

    it('200: role=host shows the host side with the guest as counterpart', async () => {
      seedBooking(s);
      const res = await list('?role=host', HOST);
      expect(res.body.total).toBe(1);
      expect(res.body.bookings[0].counterpartName).toBe('Gita Guest');
      expect((await list('?role=host', GUEST)).body.total).toBe(0);
    });

    it('200: refunded payments do not count as paid; reviewed flag reflects own reviews', async () => {
      const b = seedBooking(s, { status: 'completed' });
      seedPayment(s, b.id, { status: 'refunded' });
      s.reviews.seed({ booking_id: b.id, author_id: GUEST });
      const [row] = (await list()).body.bookings;
      expect(row).toMatchObject({ isPaid: false, hasReviewed: true });
    });

    it('200: pagination slices results', async () => {
      for (let i = 0; i < 3; i++) seedBooking(s);
      const res = await list('?page=2&pageSize=2');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 2, pageSize: 2, total: 3 });
      expect(res.body.bookings).toHaveLength(1);
    });

    it.each([
      ['role=admin', /role must be one of/],
      ['page=0', /page must not be less than 1/],
      ['page=abc', /page must be an integer/],
      ['pageSize=101', /pageSize must not be greater than 100/],
      ['pageSize=0', /pageSize must not be less than 1/],
    ])('400 invalid query %s', async (q, msg) => {
      expectError(await list(`?${q}`), 400, msg);
    });
  });

  describe('GET /api/bookings/:id', () => {
    it('200 for the guest and for the host, with payment status', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      seedPayment(s, b.id);
      for (const u of [GUEST, HOST]) {
        const res = await api().get(`/api/bookings/${b.id}`).set('Cookie', as(u));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, booking: { id: b.id, hostName: 'Hari Host', listingTitle: 'Pine Cottage', paymentStatus: 'held', status: 'confirmed' } });
      }
    });
    it('paymentStatus is null when unpaid', async () => {
      const b = seedBooking(s);
      expect((await api().get(`/api/bookings/${b.id}`).set('Cookie', as(GUEST))).body.booking.paymentStatus).toBeNull();
    });
    it('403 for a user who is not on the booking', async () => {
      const b = seedBooking(s);
      expectError(await api().get(`/api/bookings/${b.id}`).set('Cookie', as(STRANGER)), 403);
    });
    it('404 for an unknown booking', async () => {
      expectError(await api().get(`/api/bookings/${MISSING_ID}`).set('Cookie', as(GUEST)), 404, /Booking not found/);
    });
  });

  describe('POST /api/bookings/:id/approve', () => {
    const approve = (id: string, user = HOST) => api().post(`/api/bookings/${id}/approve`).set('Cookie', as(user));

    it('201: host approves; no check-in code exists yet (unpaid) and guest is notified', async () => {
      const b = seedBooking(s);
      const res = await approve(b.id);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, message: 'Booking approved.', status: 'confirmed' });
      expect(res.body.checkinCode).toBeUndefined();
      expect(b.status).toBe('confirmed');
      expect(b.checkin_code).toBeNull();
      expect(s.events.rows.at(-1)).toMatchObject({ from_status: 'requested', to_status: 'confirmed', actor: HOST });
      expect(s.notify).toHaveBeenCalledWith('booking.confirmed', GUEST, expect.not.objectContaining({ checkinCode: expect.anything() }));
      expect(s.notify).not.toHaveBeenCalledWith('booking.checkin_code_ready', expect.anything(), expect.anything());
    });
    it('403 for the guest (wrong role) and for a stranger', async () => {
      const b = seedBooking(s);
      expectError(await approve(b.id, GUEST), 403);
      expectError(await approve(b.id, STRANGER), 403);
      expect(b.status).toBe('requested');
    });
    it('404 for an unknown booking', async () => {
      expectError(await approve(MISSING_ID), 404);
    });
    it('409 when approved twice / not in requested', async () => {
      const b = seedBooking(s);
      expect((await approve(b.id)).status).toBe(201);
      expectError(await approve(b.id), 409, /Cannot approve a booking in status "confirmed"/);
    });
    it('409 when the status changes between read and write', async () => {
      const b = seedBooking(s);
      s.bookings.update = async () => ({ affected: 0 });
      expectError(await approve(b.id), 409, /changed during operation/);
    });
  });

  describe('POST /api/bookings/:id/decline', () => {
    const decline = (id: string, body: any = { reason: 'Dates unavailable' }, user = HOST) => api().post(`/api/bookings/${id}/decline`).set('Cookie', as(user)).send(body);

    it('201: host declines with a reason', async () => {
      const b = seedBooking(s);
      const res = await decline(b.id);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, message: 'Booking declined.', status: 'declined' });
      expect(b).toMatchObject({ status: 'declined', rejection_reason: 'Dates unavailable' });
      expect(s.notify).toHaveBeenCalledWith('booking.declined', GUEST, expect.anything());
    });
    it.each([
      ['missing reason', {}, /reason/],
      ['empty reason', { reason: '' }, /reason should not be empty/],
      ['non-string reason', { reason: 5 }, /reason must be a string/],
      ['reason over 1000 chars', { reason: 'x'.repeat(1001) }, /reason must be shorter/],
    ])('400 %s', async (_l, body, msg) => {
      const b = seedBooking(s);
      expectError(await decline(b.id, body), 400, msg);
      expect(b.status).toBe('requested');
    });
    it('403 for guest / stranger', async () => {
      const b = seedBooking(s);
      expectError(await decline(b.id, undefined, GUEST), 403);
      expectError(await decline(b.id, undefined, STRANGER), 403);
    });
    it('404 unknown booking', async () => {
      expectError(await decline(MISSING_ID), 404);
    });
    it('409 when not in requested', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      expectError(await decline(b.id), 409, /Cannot decline a booking in status "confirmed"/);
    });
  });

  describe('POST /api/bookings/:id/cancel', () => {
    const cancel = (id: string, user = GUEST) => api().post(`/api/bookings/${id}/cancel`).set('Cookie', as(user));

    it('201: guest cancels a requested booking; host is notified', async () => {
      const b = seedBooking(s);
      const res = await cancel(b.id);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, message: 'Booking cancelled.', status: 'cancelled' });
      expect(b.status).toBe('cancelled');
      expect(s.notify).toHaveBeenCalledWith('booking.cancelled', HOST, expect.anything());
    });
    it('201: host may cancel a confirmed booking; guest is notified', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      expect((await cancel(b.id, HOST)).status).toBe(201);
      expect(s.events.rows.at(-1)).toMatchObject({ from_status: 'confirmed', to_status: 'cancelled', actor: HOST });
      expect(s.notify).toHaveBeenCalledWith('booking.cancelled', GUEST, expect.anything());
    });
    it('403 for a stranger', async () => {
      const b = seedBooking(s);
      expectError(await cancel(b.id, STRANGER), 403);
    });
    it('404 unknown booking', async () => {
      expectError(await cancel(MISSING_ID), 404);
    });
    it.each(['checked_in', 'cancelled', 'declined', 'completed'])('409 when status is %s', async (status) => {
      const b = seedBooking(s, { status });
      expectError(await cancel(b.id), 409, new RegExp(`Cannot cancel a booking in status "${status}"`));
    });
    it('409 on a second cancel', async () => {
      const b = seedBooking(s);
      await cancel(b.id);
      expectError(await cancel(b.id), 409);
    });
  });

  describe('POST /api/bookings/:id/pay', () => {
    const pay = (id: string, user = GUEST) => api().post(`/api/bookings/${id}/pay`).set('Cookie', as(user));

    it('201: returns a Cashfree checkout session and leaves a pending payment (no code, no notifications yet)', async () => {
      const b = seedBooking(s, { status: 'confirmed', due_at_move_in: 5000 });
      const res = await pay(b.id);
      expect(res.status).toBe(201);
      const orderId = `bk_${b.id.replace(/-/g, '')}_1`;
      expect(res.body).toMatchObject({ success: true, message: 'Payment started.', status: 'confirmed', paid: false, orderId, paymentSessionId: `session_${orderId}`, checkoutMode: 'sandbox' });
      expect(s.cashfree.createPgOrder).toHaveBeenCalledWith(expect.objectContaining({ orderId, amount: 5000, customerId: GUEST, customerPhone: '9876543210' }));
      expect(s.payments.rows).toHaveLength(1);
      expect(s.payments.rows[0]).toMatchObject({
        booking_id: b.id,
        amount: 5000,
        status: 'pending',
        attempt: 1,
        cashfree_order_id: orderId,
        cashfree_split_payload: { platform_amount: 500, splits: [{ vendor_id: `SIMULATED-VENDOR-${HOST}`, amount: 4500 }] },
      });
      expect(b.checkin_code).toBeNull();
      expect(s.notify).not.toHaveBeenCalled();
    });
    it('400 when the guest has no usable mobile number; nothing is created', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      s.profiles.rows.find((r) => r.id === GUEST)!.phone = null;
      expectError(await pay(b.id), 400, /mobile number/);
      expect(s.cashfree.createPgOrder).not.toHaveBeenCalled();
      expect(s.payments.rows).toHaveLength(0);
    });
    it('paying again while the order is ACTIVE returns the same order and creates nothing new', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      const first = await pay(b.id);
      const second = await pay(b.id);
      expect(second.status).toBe(201);
      expect(second.body).toMatchObject({ paid: false, orderId: first.body.orderId, paymentSessionId: first.body.paymentSessionId });
      expect(s.cashfree.createPgOrder).toHaveBeenCalledTimes(1);
      expect(s.payments.rows).toHaveLength(1);
    });
    it('paying again when Cashfree already shows the order PAID confirms it instead of starting another', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      const first = await pay(b.id);
      s.orders.get(first.body.orderId)!.status = 'PAID';
      const res = await pay(b.id);
      expect(res.body).toMatchObject({ success: true, status: 'confirmed', paid: true });
      expect(s.payments.rows[0].status).toBe('held');
      expect(b.checkin_code).toMatch(/^\d{4}$/);
      expect(s.cashfree.createPgOrder).toHaveBeenCalledTimes(1);
    });
    it('an EXPIRED order is marked failed by the sync, then pay() opens attempt 2 on the same row', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      const first = await pay(b.id);
      s.orders.get(first.body.orderId)!.status = 'EXPIRED';
      const status = await api().get(`/api/bookings/${b.id}/payment`).set('Cookie', as(GUEST));
      expect(status.body).toMatchObject({ success: true, paymentStatus: 'failed' });
      expect(s.payments.rows[0].status).toBe('failed');

      const retry = await pay(b.id);
      expect(retry.status).toBe(201);
      expect(retry.body.orderId).toBe(`bk_${b.id.replace(/-/g, '')}_2`);
      expect(retry.body.orderId).not.toBe(first.body.orderId);
      expect(s.payments.rows).toHaveLength(1);
      expect(s.payments.rows[0]).toMatchObject({ status: 'pending', attempt: 2, cashfree_order_id: retry.body.orderId });
    });
    it('a pending row whose Cashfree order is gone (404) is replaced with a new attempt', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      const first = await pay(b.id);
      s.orders.delete(first.body.orderId);
      const retry = await pay(b.id);
      expect(retry.body.orderId).toMatch(/_2$/);
      expect(s.payments.rows[0]).toMatchObject({ status: 'pending', attempt: 2 });
    });
    it('cancelling the booking marks a pending payment failed', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      await pay(b.id);
      const res = await api().post(`/api/bookings/${b.id}/cancel`).set('Cookie', as(GUEST));
      expect(res.status).toBe(201);
      expect(s.payments.rows[0].status).toBe('failed');
    });
    it('list(): isPaid is false while pending and true once held; transactions hide the pending row', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      const { body } = await pay(b.id);
      const isPaid = async () => (await api().get('/api/bookings').set('Cookie', as(GUEST))).body.bookings[0].isPaid;
      expect(await isPaid()).toBe(false);
      expect((await api().get('/api/transactions').set('Cookie', as(GUEST))).body.transactions).toHaveLength(0);
      s.orders.get(body.orderId)!.status = 'PAID';
      await api().get(`/api/bookings/${b.id}/payment`).set('Cookie', as(GUEST));
      expect(await isPaid()).toBe(true);
      expect((await api().get('/api/transactions').set('Cookie', as(GUEST))).body.transactions).toHaveLength(1);
    });
    it('check-in code is visible to the host but never to the guest (list)', async () => {
      const b = seedBooking(s, { status: 'confirmed', checkin_code: '4821' });
      const hostList = await api().get('/api/bookings?role=host').set('Cookie', as(HOST));
      const guestList = await api().get('/api/bookings?role=guest').set('Cookie', as(GUEST));
      expect(JSON.stringify(guestList.body)).not.toContain('4821');
      expect(hostList.body.bookings.find((x: any) => x.id === b.id).checkinCode).toBe('4821');
    });
    it('locks check-in after 5 wrong codes, even for the right one', async () => {
      const b = seedBooking(s, { status: 'confirmed', checkin_code: '1234' });
      s.payments.seed({ booking_id: b.id, status: 'held', amount: 1 });
      for (let i = 0; i < 5; i++) {
        expectError(await api().post(`/api/bookings/${b.id}/checkin`).set('Cookie', as(GUEST)).send({ code: '0000' }), 400);
      }
      expectError(await api().post(`/api/bookings/${b.id}/checkin`).set('Cookie', as(GUEST)).send({ code: '1234' }), 429);
      expect(b.status).toBe('confirmed');
    });
    it('403 for the host (only the guest pays) and for a stranger', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      expectError(await pay(b.id, HOST), 403);
      expectError(await pay(b.id, STRANGER), 403);
      expect(s.payments.rows).toHaveLength(0);
    });
    it('404 unknown booking', async () => {
      expectError(await pay(MISSING_ID), 404);
    });
    it.each(['requested', 'declined', 'cancelled', 'checked_in'])('409 when the booking is %s', async (status) => {
      const b = seedBooking(s, { status });
      expectError(await pay(b.id), 409, new RegExp(`Cannot pay for a booking in status "${status}"`));
    });
    it('409 once the payment is held (application check) and only one payment row exists', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      const first = await pay(b.id);
      s.orders.get(first.body.orderId)!.status = 'PAID';
      await api().get(`/api/bookings/${b.id}/payment`).set('Cookie', as(GUEST));
      expectError(await pay(b.id), 409, /already been paid/);
      expect(s.payments.rows).toHaveLength(1);
    });
    it('409 when a concurrent first pay loses the unique-index race (23505 -> Conflict, not 500)', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      s.payments.save = async () => {
        throw new QueryFailedError('INSERT', [], Object.assign(new Error('duplicate key'), { code: '23505' }) as any);
      };
      expectError(await pay(b.id), 409, /already in progress/);
    });
    it('500 generic for any other payment persistence failure', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      s.payments.save = async () => {
        throw new Error('connection reset secret');
      };
      const res = await pay(b.id);
      expectError(res, 500);
      expect(res.body.message).not.toMatch(/secret/);
    });
  });

  describe('payment sync (GET /api/bookings/:id/payment)', () => {
    const pay = (id: string) => api().post(`/api/bookings/${id}/pay`).set('Cookie', as(GUEST));
    const status = (id: string, user = GUEST) => api().get(`/api/bookings/${id}/payment`).set('Cookie', as(user));
    const started = async () => {
      const b = seedBooking(s, { status: 'confirmed', due_at_move_in: 5000 });
      const { body } = await pay(b.id);
      return { b, order: s.orders.get(body.orderId)! };
    };

    it('stays pending while the order is ACTIVE', async () => {
      const { b } = await started();
      expect((await status(b.id)).body).toMatchObject({ success: true, paymentStatus: 'pending' });
      expect(s.payments.rows[0].status).toBe('pending');
      expect(s.notify).not.toHaveBeenCalled();
    });
    it('PAID flips to held exactly once: code generated, notifications sent once, a second call adds nothing', async () => {
      const { b, order } = await started();
      order.status = 'PAID';
      expect((await status(b.id)).body).toMatchObject({ paymentStatus: 'held' });
      expect(s.payments.rows[0]).toMatchObject({ status: 'held', cf_payment_id: 'cfpay-1' });
      expect(s.payments.rows[0].paid_at).toBeInstanceOf(Date);
      expect(b.checkin_code).toMatch(/^\d{4}$/);
      const code = b.checkin_code;
      expect(s.notify).toHaveBeenCalledWith('booking.payment_held', HOST, expect.anything());
      expect(s.notify).toHaveBeenCalledWith('booking.checkin_code_ready', HOST, expect.not.objectContaining({ checkinCode: expect.anything() }));
      const calls = s.notify.mock.calls.length;
      expect(calls).toBe(3);

      expect((await status(b.id)).body).toMatchObject({ paymentStatus: 'held' });
      expect(s.notify).toHaveBeenCalledTimes(calls);
      expect(b.checkin_code).toBe(code);
    });
    it('concurrent syncs of a PAID order still run the post-payment work once', async () => {
      const { b, order } = await started();
      order.status = 'PAID';
      await Promise.all([status(b.id), status(b.id), status(b.id)]);
      expect(s.notify).toHaveBeenCalledTimes(3);
      expect(s.payments.rows[0].status).toBe('held');
    });
    it('does not confirm when the paid amount differs from what we expect', async () => {
      const { b, order } = await started();
      order.status = 'PAID';
      order.amount = 1;
      expect((await status(b.id)).body).toMatchObject({ paymentStatus: 'pending' });
      expect(s.payments.rows[0].status).toBe('pending');
      expect(b.checkin_code).toBeNull();
      expect(s.notify).not.toHaveBeenCalled();
    });
    it('does not confirm when the order currency is not INR', async () => {
      const { b, order } = await started();
      order.status = 'PAID';
      order.currency = 'USD';
      expect((await status(b.id)).body).toMatchObject({ paymentStatus: 'pending' });
      expect(s.payments.rows[0].status).toBe('pending');
    });
    it.each(['EXPIRED', 'TERMINATED'])('%s -> failed', async (orderStatus) => {
      const { b, order } = await started();
      order.status = orderStatus;
      expect((await status(b.id)).body).toMatchObject({ paymentStatus: 'failed' });
      expect(s.payments.rows[0].status).toBe('failed');
    });
    it('the host may check too; a stranger gets 403; unknown booking 404; no payment -> none', async () => {
      const { b } = await started();
      expect((await status(b.id, HOST)).status).toBe(200);
      expectError(await status(b.id, STRANGER), 403);
      expectError(await status(MISSING_ID), 404);
      const other = seedBooking(s, { status: 'confirmed' });
      expect((await status(other.id)).body).toMatchObject({ paymentStatus: 'none' });
    });
  });

  describe('POST /api/payments/cashfree/webhook', () => {
    const TS = '1700000000000';
    const sign = (raw: string, secret = PG_SECRET, ts = TS) => createHmac('sha256', secret).update(ts + raw).digest('base64');
    const payload = (orderId: string) => JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: orderId, order_amount: 5000 } } });
    const post = (raw: string, headers: Record<string, string> = {}) =>
      api().post('/api/payments/cashfree/webhook').set('Content-Type', 'application/json').set(headers).send(raw);
    const signed = (raw: string) => ({ 'x-webhook-signature': sign(raw), 'x-webhook-timestamp': TS });

    const started = async () => {
      const b = seedBooking(s, { status: 'confirmed', due_at_move_in: 5000 });
      const res = await api().post(`/api/bookings/${b.id}/pay`).set('Cookie', as(GUEST));
      return { b, orderId: res.body.orderId as string };
    };

    it('401 without signature headers and for a bad signature; nothing changes', async () => {
      const { b, orderId } = await started();
      s.orders.get(orderId)!.status = 'PAID';
      const raw = payload(orderId);
      expectError(await post(raw), 401, /signature/);
      expectError(await post(raw, { 'x-webhook-signature': sign(raw, 'wrong-secret'), 'x-webhook-timestamp': TS }), 401);
      expectError(await post(raw, { 'x-webhook-signature': sign(raw), 'x-webhook-timestamp': '1' }), 401);
      expectError(await post(payload('tampered'), signed(raw)), 401);
      expect(s.payments.rows[0].status).toBe('pending');
      expect(b.checkin_code).toBeNull();
    });
    it('200 with a good signature for a PAID order flips the payment to held once, even if delivered twice', async () => {
      const { b, orderId } = await started();
      s.orders.get(orderId)!.status = 'PAID';
      const raw = payload(orderId);
      const first = await post(raw, signed(raw));
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ received: true });
      expect(s.payments.rows[0].status).toBe('held');
      expect(b.checkin_code).toMatch(/^\d{4}$/);
      expect(s.notify).toHaveBeenCalledTimes(3);
      expect((await post(raw, signed(raw))).status).toBe(200);
      expect(s.notify).toHaveBeenCalledTimes(3);
    });
    it('a signed webhook claiming success for an order Cashfree still shows ACTIVE does not confirm', async () => {
      const { orderId } = await started();
      const raw = payload(orderId);
      expect((await post(raw, signed(raw))).status).toBe(200);
      expect(s.payments.rows[0].status).toBe('pending');
      expect(s.notify).not.toHaveBeenCalled();
    });
    it('200 (so Cashfree stops retrying) for an unknown order and for a payload with no order', async () => {
      const raw = payload('bk_unknown_1');
      expect((await post(raw, signed(raw))).status).toBe(200);
      const ping = JSON.stringify({ type: 'WEBHOOK', data: {} });
      expect((await post(ping, signed(ping))).status).toBe(200);
      expect(s.cashfree.fetchPgOrder).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/bookings/:id/checkin', () => {
    const checkin = (id: string, body: any, user = GUEST) => api().post(`/api/bookings/${id}/checkin`).set('Cookie', as(user)).send(body);
    const paidBooking = (over: Record<string, any> = {}) => {
      const b = seedBooking(s, { status: 'confirmed', checkin_code: '1234', ...over });
      seedPayment(s, b.id);
      return b;
    };

    it('201: correct code checks the guest in and starts the escrow clock', async () => {
      const b = paidBooking();
      const res = await checkin(b.id, { code: '1234' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, message: 'Check-in confirmed.', status: 'checked_in' });
      expect(new Date(res.body.escrowReleaseTime).getTime()).toBeGreaterThan(Date.now());
      expect(b).toMatchObject({ status: 'checked_in' });
      expect(b.checkin_time).toBeInstanceOf(Date);
      expect(s.notify).toHaveBeenCalledWith('booking.checked_in', HOST, expect.anything());
    });
    it.each([
      ['missing code', {}],
      ['3 digits', { code: '123' }],
      ['5 digits', { code: '12345' }],
      ['letters', { code: 'abcd' }],
      ['number instead of string', { code: 1234 }],
    ])('400 DTO validation: %s', async (_l, body) => {
      const b = paidBooking();
      expectError(await checkin(b.id, body), 400);
      expect(b.status).toBe('confirmed');
    });
    it('400 for a well-formed but wrong code', async () => {
      const b = paidBooking();
      expectError(await checkin(b.id, { code: '9999' }), 400, /incorrect/);
      expect(b.status).toBe('confirmed');
    });
    it('403 for the host (guest-only) and for a stranger', async () => {
      const b = paidBooking();
      expectError(await checkin(b.id, { code: '1234' }, HOST), 403);
      expectError(await checkin(b.id, { code: '1234' }, STRANGER), 403);
    });
    it('404 unknown booking', async () => {
      expectError(await checkin(MISSING_ID, { code: '1234' }), 404);
    });
    it('409 when the booking is not confirmed', async () => {
      const b = paidBooking({ status: 'requested' });
      expectError(await checkin(b.id, { code: '1234' }), 409, /Cannot check in a booking in status "requested"/);
    });
    it('409 when payment has not been made', async () => {
      const b = seedBooking(s, { status: 'confirmed', checkin_code: '1234' });
      expectError(await checkin(b.id, { code: '1234' }), 409, /Payment must be completed/);
    });
    it('409 when the payment is no longer held', async () => {
      const b = seedBooking(s, { status: 'confirmed', checkin_code: '1234' });
      seedPayment(s, b.id, { status: 'refunded' });
      expectError(await checkin(b.id, { code: '1234' }), 409, /Payment must be completed/);
    });
    it('409 on a second check-in', async () => {
      const b = paidBooking();
      await checkin(b.id, { code: '1234' });
      expectError(await checkin(b.id, { code: '1234' }), 409, /status "checked_in"/);
    });
  });

  describe('POST /api/bookings/:id/checkout', () => {
    const checkout = (id: string, user = GUEST) => api().post(`/api/bookings/${id}/checkout`).set('Cookie', as(user));

    it('201: guest checks out on/after move-out; host is notified', async () => {
      const b = seedBooking(s, { status: 'checked_in', move_out: day(-1) });
      const res = await checkout(b.id);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, message: 'Check-out recorded.', status: 'checked_out' });
      expect(b.status).toBe('checked_out');
      expect(b.checkout_time).toBeInstanceOf(Date);
      expect(s.notify).toHaveBeenCalledWith('booking.checked_out', HOST, expect.anything());
    });
    it('201: host may check the guest out after move-out day; also from completed', async () => {
      const b = seedBooking(s, { status: 'completed', move_out: day(-1) });
      expect((await checkout(b.id, HOST)).status).toBe(201);
      expect(s.notify).toHaveBeenCalledWith('booking.checked_out', GUEST, expect.anything());
    });
    it('409 for the guest before move-out', async () => {
      const b = seedBooking(s, { status: 'checked_in', move_out: day(3) });
      expectError(await checkout(b.id), 409, /on or after your official move-out date/);
    });
    it('409 for the host before move-out', async () => {
      const b = seedBooking(s, { status: 'checked_in', move_out: day(3) });
      expectError(await checkout(b.id, HOST), 409, /before their move-out date/);
    });
    it('409 for the host on move-out day before the listing checkout time', async () => {
      s.listings.rows[0].draft_data.house_rules = { check_out: '11:59 PM' };
      const today = new Date();
      const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const b = seedBooking(s, { status: 'checked_in', move_out: localToday });
      if (today.getHours() === 23 && today.getMinutes() === 59) return;
      expectError(await checkout(b.id, HOST), 409, /official checkout time \(11:59 PM\)/);
    });
    it('403 for a stranger', async () => {
      const b = seedBooking(s, { status: 'checked_in', move_out: day(-1) });
      expectError(await checkout(b.id, STRANGER), 403);
    });
    it('404 unknown booking', async () => {
      expectError(await checkout(MISSING_ID), 404);
    });
    it.each(['requested', 'confirmed', 'cancelled'])('409 when the booking is %s', async (status) => {
      const b = seedBooking(s, { status, move_out: day(-1) });
      expectError(await checkout(b.id), 409, new RegExp(`Cannot checkout a booking in status "${status}"`));
    });
  });

  describe('POST /api/bookings/:id/dispute (raise)', () => {
    const dispute = (id: string, body: any, user = GUEST) => api().post(`/api/bookings/${id}/dispute`).set('Cookie', as(user)).send(body);
    const valid = { category: 'cleanliness', description: 'The place was not clean at all.', requestedAmount: 2000 };
    const checkedIn = (over: Record<string, any> = {}) => {
      const b = seedBooking(s, { status: 'checked_in', escrow_release_time: new Date(Date.now() + 3600000), ...over });
      seedPayment(s, b.id);
      return b;
    };

    it('201: guest raises a dispute; case + opening event are written, host is notified', async () => {
      const b = checkedIn();
      const res = await dispute(b.id, valid);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, message: 'Dispute raised. We will look into it.', status: 'disputed' });
      expect(res.body.disputeCaseId).toBeTruthy();
      expect(b.status).toBe('disputed');
      expect(s.cases.rows[0]).toMatchObject({ booking_id: b.id, category: 'cleanliness', requested_amount: 2000, case_status: 'open' });
      expect(s.caseEvents.rows[0]).toMatchObject({ event_type: 'claim_raised', actor_role: 'guest', offer_amount: 2000 });
      expect(s.events.rows.at(-1)).toMatchObject({ from_status: 'checked_in', to_status: 'disputed' });
      expect(s.notify).toHaveBeenCalledWith('booking.disputed', HOST, expect.anything());
    });
    it.each([
      ['bad category', { category: 'rude' }, /category must be one of/],
      ['short description', { description: 'too short' }, /description must be longer than or equal to 10/],
      ['long description', { description: 'x'.repeat(2001) }, /description must be shorter/],
      ['zero amount', { requestedAmount: 0 }, /requestedAmount must not be less than 1/],
      ['fractional amount', { requestedAmount: 10.5 }, /requestedAmount must be an integer/],
      ['missing amount', { requestedAmount: undefined }, /requestedAmount/],
    ])('400 DTO validation: %s', async (_l, over, msg) => {
      const b = checkedIn();
      expectError(await dispute(b.id, { ...valid, ...over }), 400, msg);
      expect(b.status).toBe('checked_in');
    });
    it('400 when requesting more than was paid', async () => {
      const b = checkedIn();
      expectError(await dispute(b.id, { ...valid, requestedAmount: 5001 }), 400, /cannot exceed the amount paid/);
      expect(s.cases.rows).toHaveLength(0);
    });
    it('403 for host / stranger', async () => {
      const b = checkedIn();
      expectError(await dispute(b.id, valid, HOST), 403);
      expectError(await dispute(b.id, valid, STRANGER), 403);
    });
    it('404 unknown booking', async () => {
      expectError(await dispute(MISSING_ID, valid), 404);
    });
    it('409 when the booking is not checked in', async () => {
      const b = seedBooking(s, { status: 'confirmed' });
      expectError(await dispute(b.id, valid), 409, /Cannot dispute a booking in status "confirmed"/);
    });
    it('409 after the dispute window has closed', async () => {
      const b = checkedIn({ escrow_release_time: new Date(Date.now() - 1000) });
      expectError(await dispute(b.id, valid), 409, /dispute window .* closed/);
    });
    it('409 on a second dispute for the same booking', async () => {
      const b = checkedIn();
      await dispute(b.id, valid);
      expectError(await dispute(b.id, valid), 409, /status "disputed"/);
      expect(s.cases.rows).toHaveLength(1);
    });
  });

  describe('GET /api/bookings/:id/dispute', () => {
    const get = (id: string, user = GUEST) => api().get(`/api/bookings/${id}/dispute`).set('Cookie', as(user));

    it('200: both parties see the case, timeline in order, with their own viewerRole', async () => {
      const b = seedBooking(s, { status: 'disputed' });
      const c = seedCase(s, b.id);
      seedCaseEvent(s, c.id, { event_type: 'claim_raised', actor_role: 'guest' });
      seedCaseEvent(s, c.id, { event_type: 'host_offer', actor_role: 'host', offer_amount: 1000 });
      const g = await get(b.id, GUEST);
      expect(g.status).toBe(200);
      expect(g.body).toMatchObject({ success: true, viewerRole: 'guest', case: { id: c.id } });
      expect(g.body.events.map((e: any) => e.event_type)).toEqual(['claim_raised', 'host_offer']);
      expect((await get(b.id, HOST)).body.viewerRole).toBe('host');
    });
    it('403 for a stranger', async () => {
      const b = seedBooking(s, { status: 'disputed' });
      seedCase(s, b.id);
      expectError(await get(b.id, STRANGER), 403);
    });
    it('404 for an unknown booking, and for a booking with no dispute', async () => {
      expectError(await get(MISSING_ID), 404, /Booking not found/);
      const b = seedBooking(s);
      expectError(await get(b.id), 404, /No dispute found/);
    });
  });

  describe('POST /api/bookings/:id/dispute/evidence', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const evidence = (id: string, user = GUEST) => api().post(`/api/bookings/${id}/dispute/evidence`).set('Cookie', as(user));
    const disputed = (caseOver: Record<string, any> = {}) => {
      const b = seedBooking(s, { status: 'disputed' });
      const c = seedCase(s, b.id, caseOver);
      return { b, c };
    };

    it('201: uploads files, stores public URLs on the case (either party)', async () => {
      const { b, c } = disputed();
      const res = await evidence(b.id).attach('files', png, { filename: 'a.png', contentType: 'image/png' }).attach('files', Buffer.from('jpg'), { filename: 'b.jpg', contentType: 'image/jpeg' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, message: 'Evidence uploaded.' });
      expect(res.body.evidenceUrls).toHaveLength(2);
      expect(res.body.evidenceUrls[0]).toMatch(new RegExp(`^https://cdn.test/${b.id}/.+\\.png$`));
      expect(c.evidence_urls).toEqual(res.body.evidenceUrls);
      expect(s.upload).toHaveBeenCalledTimes(2);

      const host = await evidence(b.id, HOST).attach('files', png, { filename: 'c.webp', contentType: 'image/webp' });
      expect(host.status).toBe(201);
      expect(c.evidence_urls).toHaveLength(3);
    });
    it('400 when no files are sent', async () => {
      const { b } = disputed();
      expectError(await evidence(b.id).send({}), 400, /No files provided/);
    });
    it('400 for an unsupported file type', async () => {
      const { b, c } = disputed();
      expectError(await evidence(b.id).attach('files', Buffer.from('%PDF'), { filename: 'x.pdf', contentType: 'application/pdf' }), 400, /Unsupported file type/);
      expect(c.evidence_urls).toHaveLength(0);
    });
    it('400 when more than 6 files are sent in one request', async () => {
      const { b } = disputed();
      let r = evidence(b.id);
      for (let i = 0; i < 7; i++) r = r.attach('files', png, { filename: `f${i}.png`, contentType: 'image/png' });
      expect((await r).status).toBe(400);
    });
    it('400 when the case would exceed 6 evidence files in total', async () => {
      const { b } = disputed({ evidence_urls: ['1', '2', '3', '4', '5'] });
      const r = evidence(b.id).attach('files', png, { filename: 'a.png', contentType: 'image/png' }).attach('files', png, { filename: 'b.png', contentType: 'image/png' });
      expectError(await r, 400, /at most 6 evidence files/);
    });
    it('413 for a file over 5 MB', async () => {
      const { b } = disputed();
      expectError(await evidence(b.id).attach('files', Buffer.alloc(5 * 1024 * 1024 + 1), { filename: 'big.png', contentType: 'image/png' }), 413, /too large/i);
    });
    it('500 when storage fails', async () => {
      const { b } = disputed();
      s.upload.mockResolvedValueOnce({ error: { message: 'bucket down' } } as any);
      expectError(await evidence(b.id).attach('files', png, { filename: 'a.png', contentType: 'image/png' }), 500, /Upload failed/);
    });
    it('403 for a stranger', async () => {
      const { b } = disputed();
      expectError(await evidence(b.id, STRANGER).attach('files', png, { filename: 'a.png', contentType: 'image/png' }), 403);
    });
    it('404 unknown booking / booking without a dispute', async () => {
      expectError(await evidence(MISSING_ID).attach('files', png, { filename: 'a.png', contentType: 'image/png' }), 404);
      const b = seedBooking(s);
      expectError(await evidence(b.id).attach('files', png, { filename: 'a.png', contentType: 'image/png' }), 404, /No dispute found/);
    });
  });

  describe('POST /api/bookings/:id/dispute/offer', () => {
    const offer = (id: string, body: any, user = HOST) => api().post(`/api/bookings/${id}/dispute/offer`).set('Cookie', as(user)).send(body);
    const setup = (caseOver: Record<string, any> = {}) => {
      const b = seedBooking(s, { status: 'disputed' });
      seedPayment(s, b.id);
      const c = seedCase(s, b.id, caseOver);
      seedCaseEvent(s, c.id, { event_type: 'claim_raised', actor_role: 'guest', offer_amount: 3000 });
      return { b, c };
    };

    it('201: host makes the first offer; case becomes negotiating, guest is notified', async () => {
      const { b, c } = setup();
      const res = await offer(b.id, { amountToGuest: 1500, message: 'Partial refund' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, message: 'Offer sent.', caseStatus: 'negotiating' });
      expect(c).toMatchObject({ case_status: 'negotiating', negotiation_rounds: 1 });
      expect(s.caseEvents.rows.at(-1)).toMatchObject({ event_type: 'host_offer', actor_role: 'host', offer_amount: 1500, message: 'Partial refund' });
      expect(s.notify).toHaveBeenCalledWith('dispute.offer_received', GUEST, expect.anything());
    });
    it('201: guest counters after the host; 409 when the same side offers twice', async () => {
      const { b } = setup();
      await offer(b.id, { amountToGuest: 1000 });
      expectError(await offer(b.id, { amountToGuest: 1200 }), 409, /not your turn/);
      const counter = await offer(b.id, { amountToGuest: 2500 }, GUEST);
      expect(counter.status).toBe(201);
      expect(s.caseEvents.rows.at(-1)!.event_type).toBe('guest_counter');
    });
    it.each([
      ['negative amount', { amountToGuest: -1 }, /amountToGuest must not be less than 0/],
      ['fractional amount', { amountToGuest: 1.5 }, /amountToGuest must be an integer/],
      ['missing amount', {}, /amountToGuest/],
      ['non-string message', { amountToGuest: 1, message: 5 }, /message must be a string/],
      ['message too long', { amountToGuest: 1, message: 'x'.repeat(2001) }, /message must be shorter/],
    ])('400 DTO validation: %s', async (_l, body, msg) => {
      const { b } = setup();
      expectError(await offer(b.id, body), 400, msg);
    });
    it('400 when the offer exceeds the amount paid', async () => {
      const { b } = setup();
      expectError(await offer(b.id, { amountToGuest: 5001 }), 400, /between 0 and the amount paid/);
    });
    it('403 for a stranger', async () => {
      const { b } = setup();
      expectError(await offer(b.id, { amountToGuest: 1 }, STRANGER), 403);
    });
    it('404 unknown booking / no dispute', async () => {
      expectError(await offer(MISSING_ID, { amountToGuest: 1 }), 404);
      const b = seedBooking(s);
      expectError(await offer(b.id, { amountToGuest: 1 }), 404, /No dispute found/);
    });
    it.each(['resolved', 'escalated', 'admin_decided'])('409 when case is %s', async (case_status) => {
      const { b } = setup({ case_status });
      expectError(await offer(b.id, { amountToGuest: 1 }), 409, new RegExp(`status "${case_status}"`));
    });
    it('409 when negotiation rounds are exhausted', async () => {
      const { b } = setup({ case_status: 'negotiating', negotiation_rounds: 3 });
      expectError(await offer(b.id, { amountToGuest: 1 }), 409, /rounds are exhausted/);
    });
  });

  describe('POST /api/bookings/:id/dispute/respond', () => {
    const respond = (id: string, body: any, user = GUEST) => api().post(`/api/bookings/${id}/dispute/respond`).set('Cookie', as(user)).send(body);
    const negotiating = (caseOver: Record<string, any> = {}) => {
      const b = seedBooking(s, { status: 'disputed' });
      const p = seedPayment(s, b.id);
      const c = seedCase(s, b.id, { case_status: 'negotiating', negotiation_rounds: 1, ...caseOver });
      seedCaseEvent(s, c.id, { event_type: 'claim_raised', actor_role: 'guest', offer_amount: 3000 });
      seedCaseEvent(s, c.id, { event_type: 'host_offer', actor_role: 'host', offer_amount: 1500 });
      return { b, c, p };
    };

    it('201 accept: settles via split payout, booking completed, other party notified', async () => {
      const { b, c, p } = negotiating();
      const res = await respond(b.id, { action: 'accept' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, message: 'Offer accepted.', caseStatus: 'resolved' });
      expect(p).toMatchObject({ status: 'split', split_amount_to_guest: 1500 });
      expect(b.status).toBe('completed');
      expect(c).toMatchObject({ case_status: 'resolved', resolution_amount_to_guest: 1500, resolved_by: 'negotiation' });
      expect(s.caseEvents.rows.at(-1)).toMatchObject({ event_type: 'accepted', actor_role: 'guest' });
      expect(s.notify).toHaveBeenCalledWith('booking.completed', HOST, expect.anything());
    });
    it.each([
      ['reject', 'Offer rejected.', 'rejected'],
      ['escalate', 'Dispute escalated for review.', 'escalated'],
    ])('201 %s: hands the case to admin with the right message', async (action, message, eventType) => {
      const { b, c } = negotiating();
      const res = await respond(b.id, { action });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, message, caseStatus: 'escalated' });
      expect(c.case_status).toBe('escalated');
      expect(s.caseEvents.rows.at(-1)!.event_type).toBe(eventType);
      expect(s.notify).toHaveBeenCalledWith('dispute.escalated', HOST, expect.anything());
    });
    it('201 escalate is allowed straight from an open case', async () => {
      const { b } = negotiating({ case_status: 'open' });
      expect((await respond(b.id, { action: 'escalate' })).status).toBe(201);
    });
    it.each([
      ['missing action', {}],
      ['unknown action', { action: 'maybe' }],
      ['non-string action', { action: 1 }],
    ])('400 DTO validation: %s', async (_l, body) => {
      const { b } = negotiating();
      expectError(await respond(b.id, body), 400, /action must be one of/);
    });
    it('403 for a stranger', async () => {
      const { b } = negotiating();
      expectError(await respond(b.id, { action: 'accept' }, STRANGER), 403);
    });
    it('404 unknown booking / no dispute', async () => {
      expectError(await respond(MISSING_ID, { action: 'accept' }), 404);
      const b = seedBooking(s);
      expectError(await respond(b.id, { action: 'accept' }), 404, /No dispute found/);
    });
    it('409 when accepting your own offer (no standing offer from the other side)', async () => {
      const { b } = negotiating();
      expectError(await respond(b.id, { action: 'accept' }, HOST), 409, /No standing offer/);
    });
    it('409 when accepting with no offer made yet', async () => {
      const { b } = negotiating();
      s.caseEvents.rows.splice(1, 1);
      expectError(await respond(b.id, { action: 'accept' }), 409, /No standing offer/);
    });
    it.each(['resolved', 'escalated'])('409 when the case is already %s', async (case_status) => {
      const { b } = negotiating({ case_status });
      expectError(await respond(b.id, { action: 'reject' }), 409, new RegExp(`status "${case_status}"`));
    });
    it('409 when accepting on an open case (only escalate is allowed there)', async () => {
      const { b } = negotiating({ case_status: 'open' });
      expectError(await respond(b.id, { action: 'accept' }), 409, /status "open"/);
    });
  });

  describe('POST /api/bookings/:id/dispute/appeal', () => {
    const appeal = (id: string, body: any, user = GUEST) => api().post(`/api/bookings/${id}/dispute/appeal`).set('Cookie', as(user)).send(body);
    const decided = (caseOver: Record<string, any> = {}) => {
      const b = seedBooking(s, { status: 'completed' });
      const c = seedCase(s, b.id, { case_status: 'admin_decided', ...caseOver });
      return { b, c };
    };

    it('201: either party may appeal an admin decision once', async () => {
      const { b, c } = decided();
      const res = await appeal(b.id, { message: 'I disagree with the decision.' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, message: 'Appeal submitted.', caseStatus: 'appealed' });
      expect(c).toMatchObject({ case_status: 'appealed', appeal_used: true });
      expect(s.caseEvents.rows.at(-1)).toMatchObject({ event_type: 'appeal_raised', actor_role: 'guest', message: 'I disagree with the decision.' });
      expect(s.notify).toHaveBeenCalledWith('dispute.appeal_raised', HOST, expect.anything());
    });
    it('201 for the host too', async () => {
      const { b } = decided();
      expect((await appeal(b.id, { message: 'Unfair.' }, HOST)).status).toBe(201);
    });
    it.each([
      ['missing message', {}, /message/],
      ['empty message', { message: '' }, /message must be longer than or equal to 1/],
      ['message too long', { message: 'x'.repeat(2001) }, /message must be shorter/],
      ['non-string message', { message: 7 }, /message must be a string/],
    ])('400 DTO validation: %s', async (_l, body, msg) => {
      const { b } = decided();
      expectError(await appeal(b.id, body), 400, msg);
    });
    it('403 for a stranger', async () => {
      const { b } = decided();
      expectError(await appeal(b.id, { message: 'hi' }, STRANGER), 403);
    });
    it('404 unknown booking / no dispute', async () => {
      expectError(await appeal(MISSING_ID, { message: 'x' }), 404);
      const b = seedBooking(s);
      expectError(await appeal(b.id, { message: 'x' }), 404, /No dispute found/);
    });
    it('409 when the case has not been decided by an admin', async () => {
      const { b } = decided({ case_status: 'negotiating' });
      expectError(await appeal(b.id, { message: 'x' }), 409, /Only an admin-decided case/);
    });
    it('409 when already appealed once (and second attempt via the API also fails)', async () => {
      const { b } = decided({ appeal_used: true });
      expectError(await appeal(b.id, { message: 'x' }), 409, /already been appealed/);
      const second = decided();
      await appeal(second.b.id, { message: 'first' });
      expectError(await appeal(second.b.id, { message: 'second' }), 409);
    });
  });

  describe('GET /api/transactions', () => {
    const tx = (q = '', user = GUEST) => api().get(`/api/transactions${q}`).set('Cookie', as(user));
    let guestBooking: any;
    let guestAsHostBooking: any;

    beforeEach(() => {
      guestBooking = seedBooking(s, { status: 'confirmed' });
      seedPayment(s, guestBooking.id, { amount: 5000 });
      guestAsHostBooking = seedBooking(s, { guest_id: STRANGER, host_id: GUEST, status: 'confirmed' });
      seedPayment(s, guestAsHostBooking.id, { amount: 7000, status: 'released_to_host', cashfree_payout_id: 'SIMULATED-p' });
      const unrelated = seedBooking(s, { guest_id: STRANGER, host_id: 'someone-else' });
      seedPayment(s, unrelated.id);
    });

    it('200: without role returns both sides, shaped, GET not wrapped with a message', async () => {
      const res = await tx();
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBeUndefined();
      expect(res.body.transactions).toHaveLength(2);
      expect(res.body.transactions[0]).toEqual(
        expect.objectContaining({ id: expect.any(String), amount: expect.any(Number), status: expect.any(String), bookingId: expect.any(String), moveIn: expect.any(String), moveOut: expect.any(String), cashfreeOrderId: expect.any(String) }),
      );
    });
    it('200: role=guest only the payments the user made', async () => {
      const { body } = await tx('?role=guest');
      expect(body.transactions.map((t: any) => t.bookingId)).toEqual([guestBooking.id]);
      expect(body.transactions[0]).toMatchObject({ amount: 5000, status: 'held', listingTitle: 'Pine Cottage', cashfreePayoutId: null });
    });
    it('200: role=host only payments for the user as host', async () => {
      const { body } = await tx('?role=host');
      expect(body.transactions.map((t: any) => t.bookingId)).toEqual([guestAsHostBooking.id]);
      expect(body.transactions[0]).toMatchObject({ amount: 7000, status: 'released_to_host', cashfreePayoutId: 'SIMULATED-p' });
    });
    it('200: a user with no transactions gets an empty list; titles fall back to "Listing"', async () => {
      expect((await tx('', 'nobody')).body).toEqual({ success: true, transactions: [] });
      s.listings.rows.length = 0;
      expect((await tx('?role=guest')).body.transactions[0].listingTitle).toBe('Listing');
    });
    it('does not leak another user\'s payments', async () => {
      const { body } = await tx('', STRANGER);
      expect(body.transactions.map((t: any) => t.bookingId).sort()).toEqual([guestAsHostBooking.id, s.bookings.rows[2].id].sort());
      expect(body.transactions.some((t: any) => t.bookingId === guestBooking.id)).toBe(false);
    });
    it('200 (current behaviour, not 400): unknown role falls back to both sides', async () => {
      expect((await tx('?role=admin')).body.transactions).toHaveLength(2);
    });
  });
});
