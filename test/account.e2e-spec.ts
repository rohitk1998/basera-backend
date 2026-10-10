import * as crypto from 'node:crypto';
import * as bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { ResponseMessageInterceptor } from '../src/common/interceptors/response-message.interceptor';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { AuthGuard, SESSION_COOKIE } from '../src/auth/auth.guard';
import { AdminGuard } from '../src/auth/admin.guard';
import { FirebaseAdminProvider } from '../src/auth/firebase-admin.provider';
import { SupabaseProvider } from '../src/auth/supabase.provider';
import { UserController } from '../src/user/user.controller';
import { UserService } from '../src/user/user.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { AttractionsController } from '../src/attractions/attractions.controller';
import { AdminAttractionsController } from '../src/attractions/admin-attractions.controller';
import { AttractionsService } from '../src/attractions/attractions.service';
import { AttractionsImportService } from '../src/attractions/attractions-import.service';
import { AttractionImagesService } from '../src/attractions/attraction-images.service';
import { RedisService } from '../src/redis/redis.service';
import { AttractionEntity } from '../src/entities/attraction.entity';
import { EmailOtpEntity, UserEntity, VerificationRequestEntity } from '../src/entities';

const JWT_SECRET = 'test-secret-for-account-e2e';
const REFRESH_COOKIE = 'basera_refresh_token';
const DAY = 24 * 60 * 60 * 1000;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const firebaseUidToUserId = (uid: string) => {
  const md5 = crypto.createHash('md5').update(uid).digest('hex');
  return `${md5.slice(0, 8)}-${md5.slice(8, 12)}-4${md5.slice(13, 16)}-a${md5.slice(17, 20)}-${md5.slice(20, 32)}`;
};

/* ── In-memory stand-ins ──────────────────────────────────────────────────── */

function matches(row: any, where: any) {
  return Object.entries(where ?? {}).every(([k, v]) => row[k] === v);
}

function makeProfiles() {
  const rows = new Map<string, any>();
  const repo = {
    insertError: null as any,
    updateError: null as any,
    findOne: async ({ where }: any) => {
      const r = [...rows.values()].find((x) => matches(x, where));
      return r ? { ...r } : null;
    },
    update: async (criteria: any, patch: any) => {
      if (repo.updateError) throw repo.updateError;
      const id = typeof criteria === 'string' ? criteria : criteria.id;
      const row = rows.get(id);
      if (row) Object.assign(row, patch);
    },
    insert: async (row: any) => {
      if (repo.insertError) throw repo.insertError;
      if (row.email && [...rows.values()].some((r) => r.email === row.email)) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      rows.set(row.id, { full_name: null, role: null, refresh_token_hash: null, refresh_token_expires_at: null, fcm_tokens: [], ...row });
    },
    delete: async (where: any) => {
      for (const [id, r] of rows) if (matches(r, where)) rows.delete(id);
    },
  };
  const seed = (p: any) => (rows.set(p.id, { full_name: 'Asha Rao', email: `${p.id}@x.in`, role: null, languages: ['en'], isHost: false, created_at: new Date(Date.now() - 60 * DAY), refresh_token_hash: null, refresh_token_expires_at: null, fcm_tokens: [], ...p }), rows.get(p.id));
  return { rows, repo, seed };
}

function makeVerifications() {
  const rows: any[] = [];
  return {
    rows,
    repo: {
      findOne: async ({ where, order }: any) => {
        const hits = rows.filter((r) => Object.entries(where ?? {}).every(([k, v]) => r[k] === v));
        if (order?.submitted_at === 'DESC') hits.sort((a, b) => b.submitted_at - a.submitted_at);
        return hits[0] ?? null;
      },
    },
  };
}

function makeOtps() {
  const rows = new Map<string, any>();
  return {
    rows,
    repo: {
      findOne: async ({ where }: any) => (rows.has(where.email) ? { ...rows.get(where.email) } : null),
      create: (x: any) => x,
      save: async (x: any) => void rows.set(x.email, { ...x }),
      delete: async ({ email }: any) => void rows.delete(email),
      update: async ({ email }: any, patch: any) => void Object.assign(rows.get(email), patch),
    },
  };
}

function makeAttractions() {
  const rows: any[] = [];
  let seq = 0;
  const filterRows = (conds: Array<[string, any]>, params: Record<string, any>) =>
    rows.filter((r) => conds.every(([col, p]) => (col === 'search' ? String(r.name).toLowerCase().includes(String(params.search).replace(/%/g, '').toLowerCase()) : r[col] === params[p])));
  const qb = () => {
    const state: { select?: string; conds: Array<[string, any]>; params: Record<string, any>; like?: string } = { conds: [], params: {} };
    const self: any = {
      select: (s: string) => ((state.select = s), self),
      addSelect: () => self,
      where: (sql: string, p: any) => {
        if (sql.startsWith('a.slug like')) state.like = String(p.p).replace('%', '');
        else {
          Object.assign(state.params, p);
          state.conds.push(['district', 'district'], ['status', 'status']);
        }
        return self;
      },
      andWhere: (sql: string, p: any) => {
        Object.assign(state.params, p);
        const col = /a\.(\w+)/.exec(sql)![1];
        state.conds.push(sql.includes('ilike') ? ['search', 'search'] : [col, col]);
        return self;
      },
      groupBy: () => self,
      orderBy: () => self,
      addOrderBy: () => self,
      take: () => self,
      getMany: async () => filterRows(state.conds, state.params).map((r) => ({ ...r })),
      getRawMany: async () => {
        if (state.select === 'a.slug') return rows.filter((r) => r.slug.startsWith(state.like!)).map((r) => ({ slug: r.slug }));
        const col = state.select === 'a.category' ? 'category' : 'status';
        const src = state.conds.length ? filterRows(state.conds, state.params) : rows;
        const by = new Map<string, number>();
        src.forEach((r) => by.set(r[col], (by.get(r[col]) ?? 0) + 1));
        return [...by].map(([k, n]) => ({ [col]: k, n }));
      },
    };
    return self;
  };
  const repo = {
    create: (x: any) => ({ id: undefined, image_url: null, image_credit: null, wikipedia_url: null, created_at: new Date(), updated_at: new Date(), ...x }),
    save: async (x: any) => {
      if (!x.id) {
        x.id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
        rows.push(x);
      }
      return x;
    },
    findOne: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
    find: async ({ where, take }: any) => rows.filter((r) => matches(r, where)).sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name)).slice(0, take),
    delete: async (id: string) => void rows.splice(rows.findIndex((r) => r.id === id), 1),
    createQueryBuilder: qb,
  };
  const seed = (p: any) => repo.save(repo.create({ slug: p.name.toLowerCase().replace(/\W+/g, '-'), category: 'temple', district: 'Kullu', tehsil: null, lat: 32, lng: 77, summary: null, description: null, difficulty: null, duration: null, distance_km: null, best_season: null, youtube_ids: [], popularity: 50, source: 'manual', source_id: null, status: 'published', ...p }));
  return { rows, repo, seed };
}

/* ── Suite ────────────────────────────────────────────────────────────────── */

describe('Account, user and attractions (HTTP, real controllers + services + guards, in-memory fakes)', () => {
  let app: INestApplication;
  let P: ReturnType<typeof makeProfiles>;
  let O: ReturnType<typeof makeOtps>;
  let V: ReturnType<typeof makeVerifications>;
  let A: ReturnType<typeof makeAttractions>;
  let sentCodes: Array<{ email: string; code: string }>;
  let smtpFails: boolean;
  let notify: jest.Mock;
  let firebase: { verifyIdToken: jest.Mock };
  let storage: { fail: boolean; uploads: Array<{ path: string; type: string }> };
  let redisStore: Map<string, string>;
  let commonsResult: { url: string; credit: string } | null;
  let importer: { running: boolean; started: any[] };
  let youtubeKey: string | undefined;

  beforeEach(async () => {
    P = makeProfiles();
    O = makeOtps();
    V = makeVerifications();
    A = makeAttractions();
    sentCodes = [];
    smtpFails = false;
    notify = jest.fn();
    firebase = { verifyIdToken: jest.fn() };
    storage = { fail: false, uploads: [] };
    redisStore = new Map();
    commonsResult = { url: 'https://upload.wikimedia.org/x.jpg', credit: 'Someone, CC BY-SA 4.0, via Wikimedia Commons' };
    importer = { running: false, started: [] };
    youtubeKey = 'yt-key';

    const supabase = {
      client: {
        storage: {
          from: () => ({
            upload: async (path: string, _buf: Buffer, opts: any) => {
              storage.uploads.push({ path, type: opts.contentType });
              return { error: storage.fail ? new Error('boom') : null };
            },
            getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/avatars/${path}` } }),
          }),
        },
      },
    };
    const redis = {
      get: async (k: string) => redisStore.get(k) ?? null,
      set: async (k: string, v: string) => (redisStore.set(k, v), true),
      getVersion: async (k: string) => redisStore.get(k) ?? '0',
      incrementVersion: async (k: string) => {
        const n = Number(redisStore.get(k) ?? 0) + 1;
        redisStore.set(k, String(n));
        return n;
      },
    };
    const importService = {
      isConfigured: () => true,
      getStatus: () => ({ running: importer.running, log: [], found: 0 }),
      start: (opts: any) => {
        if (importer.running) throw new (require('@nestjs/common').ConflictException)('An import is already running.');
        importer.started.push(opts);
        importer.running = true;
        return { running: true, log: [], found: 0 };
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, UserController, AttractionsController, AdminAttractionsController],
      providers: [
        AuthService,
        UserService,
        AttractionsService,
        AuthGuard,
        AdminGuard,
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: FirebaseAdminProvider, useValue: { auth: firebase } },
        { provide: SupabaseProvider, useValue: supabase },
        {
          provide: NotificationsService,
          useValue: {
            notify,
            sendEmailOtpViaSmtp: async (email: string, p: { code: string }) => {
              if (smtpFails) throw new Error('smtp down');
              sentCodes.push({ email, code: p.code });
            },
          },
        },
        { provide: RedisService, useValue: redis },
        { provide: AttractionsImportService, useValue: importService },
        { provide: AttractionImagesService, useValue: { copyFromCommons: async () => commonsResult } },
        { provide: getRepositoryToken(UserEntity), useValue: P.repo },
        { provide: getRepositoryToken(EmailOtpEntity), useValue: O.repo },
        { provide: getRepositoryToken(VerificationRequestEntity), useValue: V.repo },
        { provide: getRepositoryToken(AttractionEntity), useValue: A.repo },
        { provide: ConfigService, useValue: { get: (k: string) => ({ SUPABASE_JWT_SECRET: JWT_SECRET, YOUTUBE_API_KEY: youtubeKey })[k] } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const token = (sub: string, opts: jwt.SignOptions = {}) => jwt.sign({ sub, role: 'authenticated', phone_number: '+911234567890' }, JWT_SECRET, { expiresIn: '1h', ...opts });
  const sessionCookie = (t: string) => `${SESSION_COOKIE}=${encodeURIComponent(JSON.stringify({ access_token: t, refresh_token: '' }))}`;
  const as = (id: string) => sessionCookie(token(id));
  const cookiesOf = (res: request.Response) => ((res.headers['set-cookie'] as unknown as string[]) ?? []);
  const cookieNamed = (res: request.Response, name: string) => cookiesOf(res).find((c) => c.startsWith(`${name}=`));
  const failureShape = (res: request.Response, status: number) => {
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ success: false, statusCode: status });
    expect(typeof res.body.message).toBe('string');
    expect(res.body.error).toBe(res.body.message);
  };
  const user = (id = 'u1', extra: any = {}) => P.seed({ id, ...extra });
  const admin = (id = 'admin1') => P.seed({ id, role: 'admin', full_name: 'Root' });

  /* ═════════════════════════════ AUTH ═══════════════════════════════════ */

  describe('GET /api/auth/realtime-token', () => {
    it('401 without a session cookie', async () => {
      const res = await http().get('/api/auth/realtime-token');
      failureShape(res, 401);
      expect(res.body.message).toBe('No session cookie found');
    });
    it('401 for a forged token', async () => {
      const res = await http().get('/api/auth/realtime-token').set('Cookie', sessionCookie(jwt.sign({ sub: 'u1' }, 'other-secret')));
      failureShape(res, 401);
      expect(res.body.message).toBe('Invalid or expired session');
    });
    it('401 "Session expired" for an expired token', async () => {
      const res = await http().get('/api/auth/realtime-token').set('Cookie', sessionCookie(token('u1', { expiresIn: -10 })));
      failureShape(res, 401);
      expect(res.body.message).toBe('Session expired');
    });
    // BUG: AuthGuard throws { code: 'session_expired' } so the client can tell "refresh me" from "log in",
    // but ApiExceptionFilter only keeps `message`, so the code never reaches the response.
    it.failing('BUG: expired-session 401 should expose code "session_expired" to the client', async () => {
      const res = await http().get('/api/auth/realtime-token').set('Cookie', sessionCookie(token('u1', { expiresIn: -10 })));
      expect(res.body.code).toBe('session_expired');
    });
    it('401 for a token with no sub', async () => {
      const res = await http().get('/api/auth/realtime-token').set('Cookie', sessionCookie(jwt.sign({ purpose: 'profile-completion', email: 'a@b.in' }, JWT_SECRET)));
      failureShape(res, 401);
    });
    it('200 returns the caller own token (JSON cookie and bare-token cookie)', async () => {
      const t = token('u1');
      const a = await http().get('/api/auth/realtime-token').set('Cookie', sessionCookie(t)).expect(200);
      expect(a.body).toEqual({ token: t });
      const b = await http().get('/api/auth/realtime-token').set('Cookie', `${SESSION_COOKIE}=${t}`).expect(200);
      expect(b.body).toEqual({ token: t });
    });
  });

  describe('POST /api/auth/session (phone OTP exchange)', () => {
    it('400 when firebaseToken is missing', async () => {
      const res = await http().post('/api/auth/session').send({});
      failureShape(res, 400);
      expect(res.body.message).toBe('No token provided');
    });
    it('400 with the auth/* code when Firebase rejects the token', async () => {
      firebase.verifyIdToken.mockRejectedValue({ code: 'auth/id-token-expired' });
      const res = await http().post('/api/auth/session').send({ firebaseToken: 't' });
      failureShape(res, 400);
      expect(res.body.message).toBe('auth/id-token-expired');
    });
    it('500 with a generic message (no leak) when Firebase itself fails', async () => {
      firebase.verifyIdToken.mockRejectedValue(new Error('ECONNRESET secret-internal'));
      const res = await http().post('/api/auth/session').send({ firebaseToken: 't' });
      failureShape(res, 500);
      expect(res.body.message).not.toMatch(/ECONNRESET|secret-internal/);
    });
    it('400 when the token carries no phone number', async () => {
      firebase.verifyIdToken.mockResolvedValue({ uid: 'f1' });
      const res = await http().post('/api/auth/session').send({ firebaseToken: 't' });
      failureShape(res, 400);
      expect(res.body.message).toBe('No phone number found on token');
    });
    it('brand-new phone: hands back a proof token, creates no row and sets no cookie', async () => {
      firebase.verifyIdToken.mockResolvedValue({ uid: 'f-new', phone_number: '+911111111111' });
      const res = await http().post('/api/auth/session').send({ firebaseToken: 't' }).expect(201);
      expect(res.body).toMatchObject({ success: true, message: 'Phone verified. Finish setting up your profile.', isNewUser: true, phone: '+911111111111' });
      const claims = jwt.verify(res.body.proofToken, JWT_SECRET) as any;
      expect(claims).toMatchObject({ purpose: 'profile-completion', firebaseUid: 'f-new' });
      expect(claims.sub).toBeUndefined();
      expect(P.rows.size).toBe(0);
      expect(cookiesOf(res)).toHaveLength(0);
    });
    it('returning phone user: signs in with the 4 cookies and stores a hashed refresh token', async () => {
      const id = firebaseUidToUserId('f-old');
      user(id, { phone: '+912222222222' });
      firebase.verifyIdToken.mockResolvedValue({ uid: 'f-old', phone_number: '+912222222222' });
      const res = await http().post('/api/auth/session').send({ firebaseToken: 't' }).expect(201);
      expect(res.body).toMatchObject({ success: true, message: 'Signed in.', isNewUser: false });
      for (const n of [SESSION_COOKIE, REFRESH_COOKIE, 'device_id', 'has_session']) expect(cookieNamed(res, n)).toBeDefined();
      expect(cookieNamed(res, SESSION_COOKIE)).toMatch(/HttpOnly/);
      expect(cookieNamed(res, 'has_session')).not.toMatch(/HttpOnly/);
      const refresh = decodeURIComponent(cookieNamed(res, REFRESH_COOKIE)!.split(';')[0].split('=')[1]);
      expect(P.rows.get(id).refresh_token_hash).toBe(sha256(refresh));
      // The issued session works against a guarded route.
      const sess = cookieNamed(res, SESSION_COOKIE)!.split(';')[0];
      await http().get('/api/user/profile').set('Cookie', sess).expect(200);
    });
    it('half-created row (no name) still gets a session but is flagged isNewUser', async () => {
      const id = firebaseUidToUserId('f-half');
      user(id, { full_name: null });
      firebase.verifyIdToken.mockResolvedValue({ uid: 'f-half', phone_number: '+913333333333' });
      const res = await http().post('/api/auth/session').send({ firebaseToken: 't' }).expect(201);
      expect(res.body).toMatchObject({ isNewUser: true, message: 'Phone verified. Finish setting up your profile.' });
      expect(cookieNamed(res, SESSION_COOKIE)).toBeDefined();
    });
  });

  describe('POST /api/auth/admin-login', () => {
    let hash: string;
    beforeAll(async () => void (hash = await bcrypt.hash('s3cret-pass', 4)));
    const login = (b: any) => http().post('/api/auth/admin-login').send(b);

    it('400 for a malformed email / missing password (DTO validation)', async () => {
      const a = await login({ email: 'nope', password: 'x' });
      failureShape(a, 400);
      expect(a.body.errors).toEqual(expect.arrayContaining([expect.stringMatching(/email/i)]));
      failureShape(await login({ email: 'a@b.in' }), 400);
      failureShape(await login({ email: 'a@b.in', password: '' }), 400);
    });
    it('401 with one identical message for unknown email, non-admin, no password and wrong password', async () => {
      P.seed({ id: 'plain', email: 'plain@x.in', role: null, password_hash: hash });
      P.seed({ id: 'nopw', email: 'nopw@x.in', role: 'admin', password_hash: null });
      P.seed({ id: 'adm', email: 'adm@x.in', role: 'admin', password_hash: hash });
      const msgs: string[] = [];
      for (const b of [
        { email: 'ghost@x.in', password: 's3cret-pass' },
        { email: 'plain@x.in', password: 's3cret-pass' },
        { email: 'nopw@x.in', password: 's3cret-pass' },
        { email: 'adm@x.in', password: 'wrong' },
      ]) {
        const res = await login(b);
        failureShape(res, 401);
        expect(cookiesOf(res)).toHaveLength(0);
        msgs.push(res.body.message);
      }
      expect(new Set(msgs)).toEqual(new Set(['Invalid email or password']));
    });
    it('200 signs an admin in, sets cookies and the session opens admin routes', async () => {
      P.seed({ id: 'adm', email: 'adm@x.in', role: 'admin', password_hash: hash });
      const res = await login({ email: 'adm@x.in', password: 's3cret-pass' }).expect(200);
      expect(res.body).toMatchObject({ success: true, message: 'Signed in as admin.', redirectTo: '/admin' });
      expect(cookieNamed(res, SESSION_COOKIE)).toBeDefined();
      await http().get('/api/admin/attractions').set('Cookie', cookieNamed(res, SESSION_COOKIE)!.split(';')[0]).expect(200);
    });
  });

  describe('POST /api/auth/email-otp/send', () => {
    const send = (email: any) => http().post('/api/auth/email-otp/send').send({ email });

    it('400 for an invalid or missing email', async () => {
      failureShape(await send('not-an-email'), 400);
      failureShape(await http().post('/api/auth/email-otp/send').send({}), 400);
      expect(sentCodes).toHaveLength(0);
    });
    it('200 emails a 6-digit code and stores only its hash, against the normalised address', async () => {
      const res = await send('Asha@Example.COM').expect(200);
      expect(res.body).toMatchObject({ success: true, message: 'Verification code sent to your email.' });
      expect(sentCodes).toHaveLength(1);
      expect(sentCodes[0].email).toBe('asha@example.com');
      expect(sentCodes[0].code).toMatch(/^\d{6}$/);
      const row = O.rows.get('asha@example.com');
      expect(row.code_hash).toBe(sha256(sentCodes[0].code));
      expect(JSON.stringify(row)).not.toContain(sentCodes[0].code);
      expect(row.attempt_count).toBe(0);
    });
    it('429 when asked again within 60s, and the first code stays valid', async () => {
      await send('a@x.in').expect(200);
      const res = await send('a@x.in');
      failureShape(res, 429);
      expect(res.body.message).toMatch(/^Please wait \d+s before requesting another code\.$/);
      expect(sentCodes).toHaveLength(1);
      await http().post('/api/auth/email-otp/verify').send({ email: 'a@x.in', code: sentCodes[0].code }).expect(200);
    });
    it('a different address is not debounced; the same one is allowed again after 60s', async () => {
      await send('a@x.in').expect(200);
      await send('b@x.in').expect(200);
      O.rows.get('a@x.in').last_sent_at = new Date(Date.now() - 61_000);
      await send('a@x.in').expect(200);
      expect(sentCodes).toHaveLength(3);
      expect(O.rows.size).toBe(2); // one row per email
    });
    it('500 with a clear message when SMTP fails, storing nothing so the user can retry at once', async () => {
      smtpFails = true;
      const res = await send('a@x.in');
      failureShape(res, 500);
      expect(res.body.message).toMatch(/Could not send the verification code/);
      expect(O.rows.size).toBe(0);
      smtpFails = false;
      await send('a@x.in').expect(200);
    });
  });

  describe('POST /api/auth/email-otp/verify', () => {
    const verify = (email: any, code: any) => http().post('/api/auth/email-otp/verify').send({ email, code });
    const issue = async (email: string) => {
      await http().post('/api/auth/email-otp/send').send({ email }).expect(200);
      return sentCodes[sentCodes.length - 1].code;
    };
    const wrongCode = (c: string) => (c === '000000' ? '111111' : '000000');

    it('400 for a bad email or a code that is not exactly 6 digits', async () => {
      for (const [e, c] of [['bad', '123456'], ['a@x.in', '12345'], ['a@x.in', '1234567'], ['a@x.in', 'abcdef'], ['a@x.in', undefined]] as const) {
        failureShape(await verify(e, c), 400);
      }
      expect((await verify('a@x.in', '12')).body.message).toMatch(/Code must be 6 digits/);
    });
    it('401 when no code was ever requested', async () => {
      const res = await verify('a@x.in', '123456');
      failureShape(res, 401);
      expect(res.body.message).toBe('Invalid or expired code.');
    });
    it('401 for a wrong code and counts the attempt', async () => {
      const code = await issue('a@x.in');
      const res = await verify('a@x.in', wrongCode(code));
      failureShape(res, 401);
      expect(O.rows.get('a@x.in').attempt_count).toBe(1);
      expect(cookiesOf(res)).toHaveLength(0);
    });
    it('locks out after 5 wrong guesses: even the right code is refused and the row is gone', async () => {
      const code = await issue('a@x.in');
      for (let i = 0; i < 5; i++) await verify('a@x.in', wrongCode(code)).expect(401);
      const res = await verify('a@x.in', code);
      failureShape(res, 401);
      expect(res.body.message).toBe('Too many incorrect attempts. Request a new code.');
      expect(O.rows.has('a@x.in')).toBe(false);
    });
    it('401 for an expired code and deletes it', async () => {
      const code = await issue('a@x.in');
      O.rows.get('a@x.in').expires_at = new Date(Date.now() - 1000);
      const res = await verify('a@x.in', code);
      failureShape(res, 401);
      expect(res.body.message).toBe('Invalid or expired code.');
      expect(O.rows.has('a@x.in')).toBe(false);
    });
    it('new email: 200 with a proof token (email claim), no row, no session; the code is single-use', async () => {
      const code = await issue('new@x.in');
      const res = await verify('NEW@x.in', code).expect(200);
      expect(res.body).toMatchObject({ success: true, message: 'Email verified. Finish setting up your profile.', isNewUser: true });
      expect(jwt.verify(res.body.proofToken, JWT_SECRET)).toMatchObject({ purpose: 'profile-completion', email: 'new@x.in' });
      expect(P.rows.size).toBe(0);
      expect(cookiesOf(res)).toHaveLength(0);
      failureShape(await verify('new@x.in', code), 401); // replay
    });
    it('existing email: 200 signs in with cookies', async () => {
      user('u1', { email: 'me@x.in' });
      const code = await issue('me@x.in');
      const res = await verify('me@x.in', code).expect(200);
      expect(res.body).toMatchObject({ success: true, message: 'Signed in.', isNewUser: false });
      expect(cookieNamed(res, SESSION_COOKIE)).toBeDefined();
      expect(P.rows.get('u1').refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
    });
    it('existing email whose profile was never completed is flagged isNewUser but still signed in', async () => {
      user('u1', { email: 'me@x.in', full_name: null });
      const res = await verify('me@x.in', await issue('me@x.in')).expect(200);
      expect(res.body).toMatchObject({ isNewUser: true, message: 'Email verified. Finish setting up your profile.' });
      expect(cookieNamed(res, SESSION_COOKIE)).toBeDefined();
    });
  });

  describe('POST /api/auth/complete-signup', () => {
    const proof = (claims: any, opts: jwt.SignOptions = { expiresIn: '10m' }) => jwt.sign({ purpose: 'profile-completion', ...claims }, JWT_SECRET, opts);
    const emailProof = (email = 'new@x.in') => proof({ email });
    const submit = (f: Record<string, string | undefined>, file?: { buf: Buffer; type: string }) => {
      let r = http().post('/api/auth/complete-signup');
      for (const [k, v] of Object.entries(f)) if (v !== undefined) r = r.field(k, v);
      if (file) r = r.attach('avatar', file.buf, { filename: 'a.png', contentType: file.type });
      return r;
    };
    const good = (over: Record<string, string | undefined> = {}) => ({ name: 'Asha Rao', email: 'new@x.in', languages: JSON.stringify(['en', 'hi']), proofToken: emailProof(), ...over });

    it('200 email signup: creates the row, issues a session, no avatar -> empty url', async () => {
      const res = await submit(good({ isHost: 'true' })).expect(200);
      expect(res.body).toMatchObject({ success: true, message: 'Your account is ready.', avatar_url: '' });
      expect(P.rows.size).toBe(1);
      expect([...P.rows.values()][0]).toMatchObject({ full_name: 'Asha Rao', email: 'new@x.in', languages: ['en', 'hi'], isHost: true });
      expect(cookieNamed(res, SESSION_COOKIE)).toBeDefined();
      expect(cookieNamed(res, REFRESH_COOKIE)).toBeDefined();
    });
    it('200 phone signup lands on the deterministic Firebase-derived id, with the phone from the token', async () => {
      const res = await submit(good({ proofToken: proof({ phone: '+914444444444', firebaseUid: 'f-9' }) })).expect(200);
      const row = P.rows.get(firebaseUidToUserId('f-9'));
      expect(row).toMatchObject({ phone: '+914444444444', full_name: 'Asha Rao', isHost: false });
      expect(res.body.success).toBe(true);
    });
    it('200 with an avatar: uploaded to storage and stored on the row', async () => {
      const res = await submit(good(), { buf: Buffer.from('png-bytes'), type: 'image/png' }).expect(200);
      const [row] = [...P.rows.values()];
      expect(storage.uploads).toEqual([{ path: `${row.id}_avatar.png`, type: 'image/png' }]);
      expect(res.body.avatar_url).toBe(`https://cdn.test/avatars/${row.id}_avatar.png`);
      expect(row.avatar_url).toBe(res.body.avatar_url);
    });
    it('400 for an unsupported avatar type, before any account exists', async () => {
      const res = await submit(good(), { buf: Buffer.from('x'), type: 'application/pdf' });
      failureShape(res, 400);
      expect(res.body.message).toMatch(/Unsupported file type/);
      expect(P.rows.size).toBe(0);
    });
    it('500 and rolls the new account back when the avatar upload fails', async () => {
      storage.fail = true;
      const res = await submit(good(), { buf: Buffer.from('x'), type: 'image/png' });
      failureShape(res, 500);
      expect(P.rows.size).toBe(0);
      expect(cookiesOf(res)).toHaveLength(0);
    });
    it('400 when languages is not valid JSON', async () => {
      const res = await submit(good({ languages: '{oops' }));
      failureShape(res, 400);
      expect(res.body.message).toBe('languages must be valid JSON.');
    });
    it.each([
      ['name too short', { name: 'A' }, /Name must be at least 2/],
      ['bad email', { email: 'nope' }, /valid email/],
      ['no languages', { languages: '[]' }, /at least one language/],
      ['languages not strings', { languages: '[1,2]' }, /./],
      ['missing proof token', { proofToken: undefined }, /./],
    ])('400 on %s (DTO validation)', async (_l, over, msg) => {
      const res = await submit(good(over as any));
      failureShape(res, 400);
      expect(res.body.message).toMatch(msg);
      expect(P.rows.size).toBe(0);
    });
    it('401 for a garbage, expired, wrong-purpose or session token used as proof', async () => {
      for (const t of ['garbage', proof({ email: 'new@x.in' }, { expiresIn: -5 }), jwt.sign({ email: 'new@x.in' }, JWT_SECRET), token('u1'), jwt.sign({ purpose: 'profile-completion', email: 'x@y.in' }, 'other')]) {
        const res = await submit(good({ proofToken: t }));
        failureShape(res, 401);
        expect(res.body.message).toBe('Your verification expired. Please start over.');
      }
      expect(P.rows.size).toBe(0);
    });
    it('409 when the email already belongs to another account (phone signup)', async () => {
      user('other', { email: 'new@x.in' });
      const res = await submit(good({ proofToken: proof({ phone: '+915555555555', firebaseUid: 'f-c' }) }));
      failureShape(res, 409);
      expect(res.body.message).toBe('An account with this email already exists.');
      expect(P.rows.has(firebaseUidToUserId('f-c'))).toBe(false);
    });
    it('a replayed phone proof token re-issues a session without duplicating the row', async () => {
      const t = proof({ phone: '+916666666666', firebaseUid: 'f-r' });
      await submit(good({ proofToken: t })).expect(200);
      const res = await submit(good({ proofToken: t, name: 'Asha R' })).expect(200);
      expect(P.rows.size).toBe(1);
      expect(P.rows.get(firebaseUidToUserId('f-r')).full_name).toBe('Asha R');
      expect(cookieNamed(res, SESSION_COOKIE)).toBeDefined();
    });
    it('409 when a replayed phone token now names someone else\'s email', async () => {
      const t = proof({ phone: '+916666666666', firebaseUid: 'f-r2' });
      await submit(good({ proofToken: t })).expect(200);
      user('other', { email: 'taken@x.in' });
      // The in-memory update does not enforce uniqueness itself, so simulate the DB constraint.
      P.repo.updateError = Object.assign(new Error('dup'), { code: '23505' });
      failureShape(await submit(good({ proofToken: t, email: 'taken@x.in' })), 409);
    });
  });

  describe('POST /api/auth/refresh', () => {
    const rt = 'refresh-token-abc';
    const seedSession = (over: any = {}) => user('u1', { refresh_token_hash: sha256(rt), refresh_token_expires_at: new Date(Date.now() + DAY), ...over });
    const refresh = (cookies: string[]) => http().post('/api/auth/refresh').set('Cookie', cookies);

    it('401 without a refresh cookie', async () => {
      const res = await refresh([as('u1')]);
      failureShape(res, 401);
      expect(res.body.message).toBe('No refresh token');
    });
    it('401 without an access-token cookie, or with an undecodable one', async () => {
      seedSession();
      const a = await refresh([`${REFRESH_COOKIE}=${rt}`]);
      failureShape(a, 401);
      expect(a.body.message).toBe('No session to refresh');
      failureShape(await refresh([`${REFRESH_COOKIE}=${rt}`, `${SESSION_COOKIE}=not-a-jwt`]), 401);
    });
    it('401 for a wrong refresh token', async () => {
      seedSession();
      const res = await refresh([`${REFRESH_COOKIE}=nope`, as('u1')]);
      failureShape(res, 401);
      expect(res.body.message).toBe('Invalid or expired refresh token');
    });
    it('401 for an expired refresh token, an unknown user, or one never issued', async () => {
      seedSession({ refresh_token_expires_at: new Date(Date.now() - 1000) });
      failureShape(await refresh([`${REFRESH_COOKIE}=${rt}`, as('u1')]), 401);
      failureShape(await refresh([`${REFRESH_COOKIE}=${rt}`, as('ghost')]), 401);
      user('u2');
      failureShape(await refresh([`${REFRESH_COOKIE}=${rt}`, as('u2')]), 401);
    });
    it('200 renews the session even when the access token already expired, and rotates the refresh token', async () => {
      seedSession();
      const res = await refresh([`${REFRESH_COOKIE}=${rt}`, sessionCookie(token('u1', { expiresIn: -60 }))]).expect(200);
      expect(res.body).toMatchObject({ success: true, message: 'Session refreshed.' });
      const newRt = decodeURIComponent(cookieNamed(res, REFRESH_COOKIE)!.split(';')[0].split('=')[1]);
      expect(newRt).not.toBe(rt);
      expect(P.rows.get('u1').refresh_token_hash).toBe(sha256(newRt));
      // old refresh token is now dead
      failureShape(await refresh([`${REFRESH_COOKIE}=${rt}`, as('u1')]), 401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('200 clears all four cookies even with no session at all', async () => {
      const res = await http().post('/api/auth/logout').expect(200);
      expect(res.body).toMatchObject({ success: true, message: 'Signed out.' });
      for (const n of [SESSION_COOKIE, REFRESH_COOKIE, 'device_id', 'has_session']) expect(cookieNamed(res, n)).toMatch(/Expires=Thu, 01 Jan 1970/);
    });
    it('200 on a garbage session cookie without touching anyone', async () => {
      user('u1', { refresh_token_hash: 'keep' });
      await http().post('/api/auth/logout').set('Cookie', `${SESSION_COOKIE}=garbage`).expect(200);
      expect(P.rows.get('u1').refresh_token_hash).toBe('keep');
    });
    it('200 revokes the server-side refresh token so it cannot renew afterwards', async () => {
      user('u1', { refresh_token_hash: sha256('rt'), refresh_token_expires_at: new Date(Date.now() + DAY) });
      await http().post('/api/auth/logout').set('Cookie', as('u1')).expect(200);
      expect(P.rows.get('u1')).toMatchObject({ refresh_token_hash: null, refresh_token_expires_at: null });
      failureShape(await http().post('/api/auth/refresh').set('Cookie', [`${REFRESH_COOKIE}=rt`, as('u1')]), 401);
    });
  });

  /* ═════════════════════════════ USER ═══════════════════════════════════ */

  describe('/api/user (auth required)', () => {
    const routes: Array<[string, string, any?]> = [
      ['get', '/api/user/profile', {}],
      ['post', '/api/user/profile', {}],
      ['patch', '/api/user/profile', { isHost: true }],
      ['post', '/api/user/avatar', {}],
      ['post', '/api/user/push-token', { token: 'abcdefghijkl' }],
      ['delete', '/api/user/push-token', { token: 'abcdefghijkl' }],
      ['post', '/api/user/locale', { locale: 'en' }],
    ];
    it.each(routes)('401 for %s %s without a session, and for a forged one', async (m, path, body) => {
      const bare = await (http() as any)[m](path).send(body);
      failureShape(bare, 401);
      const forged = await (http() as any)[m](path).set('Cookie', sessionCookie(jwt.sign({ sub: 'u1' }, 'bad'))).send(body);
      failureShape(forged, 401);
    });

    describe('GET profile', () => {
      it('200 returns the caller profile with defaults and the edit-unlock date', async () => {
        const created = new Date(Date.now() - 3 * DAY);
        user('u1', { phone: '+91999', email: null, languages: null, avatar_url: null, isHost: true, created_at: created });
        const res = await http().get('/api/user/profile').set('Cookie', as('u1')).expect(200);
        expect(res.body).toMatchObject({ success: true, profile: { id: 'u1', phone: '+91999', email: '', languages: [], isHost: true, isAdmin: false, avatar_url: '', pan: '', bank_upi: '' } });
        expect(res.body.editUnlocksAt).toBe(new Date(created.getTime() + 14 * DAY).toISOString());
        expect(res.body.profile.password_hash).toBeUndefined();
      });
      // The browser's "identity verified" flag used to be re-derived (and lost)
      // client-side; the profile now carries it, from the NEWEST identity row.
      it('identity_verified is false with no identity request, true once the newest one is verified', async () => {
        user('u1');
        const get = async () => (await http().get('/api/user/profile').set('Cookie', as('u1')).expect(200)).body.profile.identity_verified;
        expect(await get()).toBe(false);
        V.rows.push({ user_id: 'u1', verification_type: 'identity', status: 'pending', submitted_at: new Date(1000) });
        expect(await get()).toBe(false);
        V.rows.push({ user_id: 'u1', verification_type: 'identity', status: 'verified', submitted_at: new Date(2000) });
        expect(await get()).toBe(true);
      });
      it('identity_verified follows the newest identity row, ignores other types and other users', async () => {
        user('u1');
        V.rows.push({ user_id: 'u1', verification_type: 'identity', status: 'verified', submitted_at: new Date(1000) });
        V.rows.push({ user_id: 'u1', verification_type: 'identity', status: 'rejected', submitted_at: new Date(2000) });
        const get = async () => (await http().get('/api/user/profile').set('Cookie', as('u1')).expect(200)).body.profile.identity_verified;
        expect(await get()).toBe(false); // an older verified row does not count after a newer rejection
        V.rows.length = 0;
        V.rows.push({ user_id: 'u1', verification_type: 'selfie', status: 'verified', submitted_at: new Date(1000) });
        V.rows.push({ user_id: 'someone-else', verification_type: 'identity', status: 'verified', submitted_at: new Date(1000) });
        expect(await get()).toBe(false);
      });
      it('falls back to legacy role=host and flags admins', async () => {
        user('h', { isHost: undefined, role: 'host' });
        admin('a');
        expect((await http().get('/api/user/profile').set('Cookie', as('h'))).body.profile).toMatchObject({ isHost: true, isAdmin: false });
        expect((await http().get('/api/user/profile').set('Cookie', as('a'))).body.profile.isAdmin).toBe(true);
      });
      it('404 when the token is valid but the profile is gone', async () => {
        const res = await http().get('/api/user/profile').set('Cookie', as('ghost'));
        failureShape(res, 404);
        expect(res.body.message).toBe('Profile not found');
      });
    });

    describe('POST profile', () => {
      const body = (o: any = {}) => ({ name: 'Asha Rao', email: 'asha@x.in', languages: ['en'], avatar_url: 'https://cdn/x.png', ...o });
      const save = (b: any, id = 'u1') => http().post('/api/user/profile').set('Cookie', as(id)).send(b);

      it.each([
        ['short name', { name: 'A' }, /Name must be at least 2/],
        ['bad email', { email: 'x' }, /valid email/],
        ['empty languages', { languages: [] }, /at least one language/],
        ['non-string language', { languages: [1] }, /./],
        ['no avatar', { avatar_url: '' }, /Avatar is required/],
        ['non-boolean isHost', { isHost: 'yes' }, /./],
      ])('400 on %s', async (_l, over, msg) => {
        user('u1', { full_name: null });
        const res = await save(body(over));
        failureShape(res, 400);
        expect(res.body.message).toMatch(msg);
      });
      it('first-time completion: 201, saved, notifies once as a host/guest-appropriate welcome', async () => {
        user('u1', { full_name: null, created_at: new Date() }); // fresh row is NOT edit-locked until a name exists
        const res = await save(body({ isHost: true })).expect(201);
        expect(res.body).toMatchObject({ success: true, message: 'Profile saved.' });
        expect(P.rows.get('u1')).toMatchObject({ full_name: 'Asha Rao', email: 'asha@x.in', isHost: true });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith('user.registered', 'u1', expect.objectContaining({ userName: 'Asha Rao', isHost: true, link: '/account?verify=1' }));
      });
      it('later edit after the lock: saved with no welcome notification', async () => {
        user('u1', { created_at: new Date(Date.now() - 15 * DAY) });
        await save(body({ name: 'New Name' })).expect(201);
        expect(P.rows.get('u1').full_name).toBe('New Name');
        expect(notify).not.toHaveBeenCalled();
      });
      it('403 while the 14-day edit lock is active, and nothing is changed', async () => {
        user('u1', { created_at: new Date(Date.now() - 2 * DAY) });
        const res = await save(body({ name: 'Renamed' }));
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ success: false, statusCode: 403 });
        expect(P.rows.get('u1').full_name).toBe('Asha Rao');
      });
      // BUG: UserService throws ForbiddenException({ error: 'Your profile can be edited again on ...', editUnlocksAt }),
      // but the filter reads only `.message`, so the client gets the bare "Forbidden Exception" and no unlock date.
      it.failing('BUG: 403 edit-lock response should carry the "can be edited again on" text and editUnlocksAt', async () => {
        user('u1', { created_at: new Date(Date.now() - 2 * DAY) });
        const res = await save(body());
        expect(res.body.message).toMatch(/can be edited again on/);
        expect(res.body.editUnlocksAt).toBeDefined();
      });
      it('409 when the new email belongs to another account', async () => {
        user('u1', { full_name: null });
        P.repo.updateError = Object.assign(new Error('dup'), { code: '23505' });
        const res = await save(body());
        failureShape(res, 409);
        expect(res.body.message).toBe('An account with this email already exists.');
      });
      it('500 (schema out of date) and generic 500 for other DB failures', async () => {
        user('u1', { full_name: null });
        P.repo.updateError = Object.assign(new Error('column x'), { code: '42703' });
        const a = await save(body());
        failureShape(a, 500);
        expect(a.body.message).toMatch(/Database schema is out of date/);
        P.repo.updateError = new Error('weird');
        const b = await save(body());
        failureShape(b, 500);
        expect(b.body.message).toBe('Failed to update profile');
      });
      it('404 when the profile row does not exist', async () => {
        failureShape(await save(body(), 'ghost'), 404);
      });
      it('ignores unknown fields (whitelist) and never lets a caller set role', async () => {
        user('u1', { full_name: null });
        await save(body({ role: 'admin' })).expect(201);
        expect(P.rows.get('u1').role).toBeNull();
      });
    });

    describe('PATCH profile (become host)', () => {
      const patch = (b: any, id = 'u1') => http().patch('/api/user/profile').set('Cookie', as(id)).send(b);
      it('200 turns host mode on and off with matching messages', async () => {
        user('u1');
        const on = await patch({ isHost: true }).expect(200);
        expect(on.body).toMatchObject({ success: true, isHost: true, message: 'You are now a host.' });
        expect(P.rows.get('u1').isHost).toBe(true);
        const off = await patch({ isHost: false }).expect(200);
        expect(off.body).toMatchObject({ isHost: false, message: 'Host mode turned off.' });
        expect(P.rows.get('u1').isHost).toBe(false);
      });
      it('400 for a missing or non-boolean isHost', async () => {
        user('u1');
        failureShape(await patch({}), 400);
        failureShape(await patch({ isHost: 'true' }), 400);
        failureShape(await patch({ isHost: 1 }), 400);
      });
      it('cannot be used to escalate: extra role field is dropped', async () => {
        user('u1');
        await patch({ isHost: true, role: 'admin' }).expect(200);
        expect(P.rows.get('u1').role).toBeNull();
      });
    });

    describe('POST avatar', () => {
      const up = (buf: Buffer | null, type = 'image/jpeg') => {
        const r = http().post('/api/user/avatar').set('Cookie', as('u1'));
        return buf ? r.attach('avatar', buf, { filename: 'a.jpg', contentType: type }) : r;
      };
      beforeEach(() => void user('u1'));

      it('400 when no file is sent', async () => {
        const res = await up(null);
        failureShape(res, 400);
        expect(res.body.message).toBe('No file provided');
      });
      it('400 for an unsupported type', async () => {
        const res = await up(Buffer.from('x'), 'text/plain');
        failureShape(res, 400);
        expect(res.body.message).toMatch(/Unsupported file type/);
      });
      it('413 for a file over 5 MB', async () => {
        const res = await up(Buffer.alloc(5 * 1024 * 1024 + 1));
        failureShape(res, 413);
        expect(res.body.message).toMatch(/File too large/);
      });
      it('200 uploads and saves the public URL on the profile', async () => {
        const res = await up(Buffer.from('jpegbytes')).expect(201);
        expect(res.body).toMatchObject({ success: true, message: 'Profile photo updated.', publicUrl: 'https://cdn.test/avatars/u1_avatar.jpg' });
        expect(P.rows.get('u1').avatar_url).toBe(res.body.publicUrl);
      });
      it('500 when storage fails', async () => {
        storage.fail = true;
        const res = await up(Buffer.from('x'));
        failureShape(res, 500);
        expect(res.body.message).toBe('Upload failed. Please try again.');
      });
      it('still returns the URL, with a warning, when only the DB write fails', async () => {
        P.repo.updateError = new Error('db');
        const res = await up(Buffer.from('x')).expect(201);
        expect(res.body).toMatchObject({ publicUrl: expect.any(String), warning: 'Profile URL not persisted' });
      });
    });

    describe('push-token', () => {
      const add = (b: any) => http().post('/api/user/push-token').set('Cookie', as('u1')).send(b);
      const del = (b: any) => http().delete('/api/user/push-token').set('Cookie', as('u1')).send(b);
      beforeEach(() => void user('u1'));

      it('400 for a missing or too-short token (POST and DELETE)', async () => {
        failureShape(await add({}), 400);
        failureShape(await add({ token: 'short' }), 400);
        failureShape(await del({ token: 'short' }), 400);
        failureShape(await del({}), 400);
      });
      it('201 adds a token once (idempotent), 200 removes it', async () => {
        const a = await add({ token: 'fcm-token-1' }).expect(201);
        expect(a.body).toMatchObject({ success: true, ok: true, message: 'Notifications enabled on this device.' });
        await add({ token: 'fcm-token-1' }).expect(201);
        await add({ token: 'fcm-token-2' }).expect(201);
        expect(P.rows.get('u1').fcm_tokens).toEqual(['fcm-token-1', 'fcm-token-2']);
        const d = await del({ token: 'fcm-token-1' }).expect(200);
        expect(d.body).toMatchObject({ success: true, message: 'Notifications disabled on this device.' });
        expect(P.rows.get('u1').fcm_tokens).toEqual(['fcm-token-2']);
      });
      it('removing an unknown token is a harmless no-op', async () => {
        await del({ token: 'never-registered' }).expect(200);
        expect(P.rows.get('u1').fcm_tokens).toEqual([]);
      });
    });

    describe('POST locale', () => {
      const set = (b: any) => http().post('/api/user/locale').set('Cookie', as('u1')).send(b);
      beforeEach(() => void user('u1'));
      it('400 for missing / too-short locale', async () => {
        failureShape(await set({}), 400);
        failureShape(await set({ locale: 'e' }), 400);
      });
      it('400 "Unsupported locale" for a well-formed but unsupported one', async () => {
        const res = await set({ locale: 'fr' });
        failureShape(res, 400);
        expect(res.body.message).toBe('Unsupported locale');
        expect(P.rows.get('u1').preferred_locale).toBeUndefined();
      });
      it.each(['en', 'hi'])('201 saves %s', async (locale) => {
        const res = await set({ locale }).expect(201);
        expect(res.body).toMatchObject({ success: true, message: 'Language updated.' });
        expect(P.rows.get('u1').preferred_locale).toBe(locale);
      });
    });
  });

  /* ═══════════════════════ ATTRACTIONS (public) ═════════════════════════ */

  describe('GET /api/attractions (public)', () => {
    beforeEach(async () => {
      await A.seed({ name: 'Hadimba Temple', category: 'temple', district: 'Kullu', popularity: 90 });
      await A.seed({ name: 'Jogini Falls', category: 'waterfall', district: 'Kullu', popularity: 70 });
      await A.seed({ name: 'Secret Draft', district: 'Kullu', status: 'draft' });
      await A.seed({ name: 'Hidden One', district: 'Kullu', status: 'hidden' });
      await A.seed({ name: 'Jakhu Temple', district: 'Shimla' });
    });

    it('200 needs no auth and returns only published places of the district, with counts', async () => {
      const res = await http().get('/api/attractions').query({ district: 'Kullu' }).expect(200);
      expect(res.body).toMatchObject({ success: true, district: 'Kullu' });
      expect(res.body.attractions.map((a: any) => a.name)).toEqual(['Hadimba Temple', 'Jogini Falls']);
      expect(res.body.counts).toMatchObject({ all: 2, temple: 1, waterfall: 1, trek: 0 });
      expect(res.body.attractions[0]).toEqual(expect.objectContaining({ slug: 'hadimba-temple', imageUrl: null, youtubeIds: [] }));
      expect(res.body.attractions[0].status).toBeUndefined(); // admin-only field
    });
    it('district is case-insensitive and resolved from tehsil or a known place name', async () => {
      expect((await http().get('/api/attractions').query({ district: 'kullu' })).body.district).toBe('Kullu');
      expect((await http().get('/api/attractions').query({ tehsil: 'Manali' })).body.district).toBe('Kullu');
      expect((await http().get('/api/attractions').query({ q: 'Kasol' })).body.district).toBe('Kullu');
    });
    it('200 with an empty answer (never 4xx) when the search is not about one district', async () => {
      for (const q of [{}, { district: 'Atlantis' }, { q: 'nowhere at all' }, { district: ['x', 'y'] }]) {
        const res = await http().get('/api/attractions').query(q as any).expect(200);
        expect(res.body).toMatchObject({ success: true, district: null, attractions: [] });
        expect(res.body.counts.all).toBe(0);
      }
    });
    it('honours limit, ignoring junk limits', async () => {
      expect((await http().get('/api/attractions').query({ district: 'Kullu', limit: 1 })).body.attractions).toHaveLength(1);
      expect((await http().get('/api/attractions').query({ district: 'Kullu', limit: 'abc' })).body.attractions).toHaveLength(2);
      expect((await http().get('/api/attractions').query({ district: 'Kullu', limit: -5 })).body.attractions).toHaveLength(2);
    });
    it('serves repeat reads from cache until an admin change bumps the version', async () => {
      await http().get('/api/attractions').query({ district: 'Shimla' }).expect(200);
      await A.seed({ name: 'Late Addition', district: 'Shimla' });
      expect((await http().get('/api/attractions').query({ district: 'Shimla' })).body.attractions).toHaveLength(1); // cached
      admin();
      await http().post('/api/admin/attractions').set('Cookie', as('admin1')).send({ name: 'Brand New', category: 'lake', district: 'Shimla', lat: 31.1, lng: 77.1, status: 'published' }).expect(201);
      expect((await http().get('/api/attractions').query({ district: 'Shimla' })).body.attractions).toHaveLength(3);
    });
  });

  /* ═══════════════════════ ATTRACTIONS (admin) ══════════════════════════ */

  describe('/api/admin/attractions', () => {
    const base = '/api/admin/attractions';
    const adm = () => as('admin1');
    const valid = (o: any = {}) => ({ name: 'Bijli Mahadev', category: 'temple', district: 'Kullu', lat: 31.86, lng: 77.17, ...o });
    const adminRoutes: Array<[string, string, any?]> = [
      ['get', base, {}],
      ['get', `${base}/import`, {}],
      ['post', `${base}/import`, {}],
      ['get', `${base}/youtube?q=manali`, {}],
      ['post', base, valid()],
      ['patch', `${base}/abc`, { name: 'Zzz' }],
      ['delete', `${base}/abc`, {}],
    ];

    describe('access control', () => {
      it.each(adminRoutes)('401 for %s %s without a session', async (m, path, body) => {
        failureShape(await (http() as any)[m](path).send(body), 401);
      });
      it.each(adminRoutes)('403 for %s %s as a regular user or host', async (m, path, body) => {
        user('u1');
        user('h1', { isHost: true, role: 'host' });
        const a = await (http() as any)[m](path).set('Cookie', as('u1')).send(body);
        failureShape(a, 403);
        expect(a.body.message).toBe('Admin role required');
        failureShape(await (http() as any)[m](path).set('Cookie', as('h1')).send(body), 403);
      });
      it('403 for a valid token whose profile does not exist', async () => {
        const res = await http().get(base).set('Cookie', as('ghost'));
        failureShape(res, 403);
        expect(res.body.message).toBe('No profile found for user');
      });
      it('nothing was changed by the rejected writes', async () => {
        user('u1');
        await http().post(base).set('Cookie', as('u1')).send(valid()).expect(403);
        expect(A.rows).toHaveLength(0);
        expect(importer.started).toHaveLength(0);
      });
    });

    describe('GET list', () => {
      beforeEach(async () => {
        admin();
        await A.seed({ name: 'Alpha Fort', category: 'fort', district: 'Kangra', status: 'published' });
        await A.seed({ name: 'Beta Trek', category: 'trek', district: 'Kullu', status: 'draft' });
        await A.seed({ name: 'Gamma Lake', category: 'lake', district: 'Kullu', status: 'hidden' });
      });
      it('200 lists everything incl. drafts with status counts and importConfigured', async () => {
        const res = await http().get(base).set('Cookie', adm()).expect(200);
        expect(res.body).toMatchObject({ success: true, importConfigured: true, counts: { draft: 1, published: 1, hidden: 1 } });
        expect(res.body.attractions).toHaveLength(3);
        expect(res.body.attractions[0]).toEqual(expect.objectContaining({ status: expect.any(String), source: 'manual', popularity: 50 }));
      });
      it('filters by district, category, status and search; ignores invalid filter values', async () => {
        const q = async (query: any) => (await http().get(base).query(query).set('Cookie', adm()).expect(200)).body.attractions.map((a: any) => a.name);
        expect(await q({ district: 'Kullu' })).toEqual(expect.arrayContaining(['Beta Trek', 'Gamma Lake']));
        expect(await q({ district: 'Kullu' })).toHaveLength(2);
        expect(await q({ category: 'fort' })).toEqual(['Alpha Fort']);
        expect(await q({ status: 'draft' })).toEqual(['Beta Trek']);
        expect(await q({ search: 'gamma' })).toEqual(['Gamma Lake']);
        expect(await q({ district: 'Atlantis', status: 'bogus' })).toHaveLength(3);
      });
    });

    describe('import', () => {
      beforeEach(() => void admin());
      it('GET import: 200 status + configured flag', async () => {
        const res = await http().get(`${base}/import`).set('Cookie', adm()).expect(200);
        expect(res.body).toMatchObject({ success: true, configured: true, status: { running: false } });
      });
      it('POST import: 201 starts a run for a valid district', async () => {
        const res = await http().post(`${base}/import`).set('Cookie', adm()).send({ district: 'Kullu' }).expect(201);
        expect(res.body).toMatchObject({ success: true, message: 'Import started. New places arrive as drafts.', status: { running: true } });
        expect(importer.started).toEqual([{ district: 'Kullu' }]);
      });
      it('POST import: an unknown/missing district means "all districts", not an error', async () => {
        await http().post(`${base}/import`).set('Cookie', adm()).send({ district: 'Atlantis' }).expect(201);
        await http().post(`${base}/import`).set('Cookie', adm()).send({}).expect(409); // already running from the first
        expect(importer.started).toEqual([{ district: undefined }]);
      });
      it('POST import: 409 while a run is already in progress', async () => {
        importer.running = true;
        const res = await http().post(`${base}/import`).set('Cookie', adm()).send({});
        failureShape(res, 409);
        expect(res.body.message).toBe('An import is already running.');
      });
    });

    describe('GET youtube', () => {
      beforeEach(() => void admin());
      const yt = (q?: any) => http().get(`${base}/youtube`).query(q === undefined ? {} : { q }).set('Cookie', adm());
      it('400 for a missing or too-short query', async () => {
        const a = await yt();
        failureShape(a, 400);
        expect(a.body.message).toBe('Type at least 2 characters to search YouTube.');
        failureShape(await yt('a'), 400);
        failureShape(await yt('  a '), 400);
      });
      it('503 when YOUTUBE_API_KEY is not configured', async () => {
        youtubeKey = undefined;
        const res = await yt('manali');
        failureShape(res, 503);
        expect(res.body.message).toMatch(/YOUTUBE_API_KEY/);
      });
      it('503 when the YouTube API fails', async () => {
        jest.spyOn(global, 'fetch').mockResolvedValue(new Response('quota', { status: 403 }));
        const res = await yt('manali');
        failureShape(res, 503);
        expect(res.body.message).toMatch(/YouTube search failed/);
      });
      it('200 maps API results to videos', async () => {
        const spy = jest.spyOn(global, 'fetch').mockResolvedValue(
          new Response(JSON.stringify({ items: [{ id: { videoId: 'dQw4w9WgXcQ' }, snippet: { title: 'Manali &amp; more', channelTitle: 'Ch', publishedAt: '2024-01-01', thumbnails: { medium: { url: 'http://t/m.jpg' } } } }, { id: {}, snippet: {} }] }), { status: 200 }),
        );
        const res = await yt('manali trek').expect(200);
        expect(res.body.success).toBe(true);
        expect(res.body.videos).toEqual([{ id: 'dQw4w9WgXcQ', title: 'Manali & more', channel: 'Ch', thumbnail: 'http://t/m.jpg', publishedAt: '2024-01-01' }]);
        expect(String(spy.mock.calls[0][0])).toContain('q=manali+trek');
      });
    });

    describe('POST create', () => {
      beforeEach(() => void admin());
      const create = (b: any) => http().post(base).set('Cookie', adm()).send(b);

      it('201 creates a draft manual place with a slug and derived summary', async () => {
        const res = await create(valid({ description: 'A famous temple. Reached by a steep walk.', youtubeIds: ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'], lat: '31.86' })).expect(201);
        expect(res.body).toMatchObject({ success: true, message: 'Place added.' });
        expect(res.body.attraction).toMatchObject({ slug: 'bijli-mahadev', status: 'draft', source: 'manual', popularity: 50, youtubeIds: ['dQw4w9WgXcQ'], lat: 31.86, summary: 'A famous temple. Reached by a steep walk.' });
        expect(A.rows).toHaveLength(1);
        // A draft is not public.
        expect((await http().get('/api/attractions').query({ district: 'Kullu' })).body.attractions).toHaveLength(0);
      });
      it('de-duplicates slugs: name, then name-district, then name-N', async () => {
        const slugs: string[] = [];
        for (let i = 0; i < 3; i++) slugs.push((await create(valid()).expect(201)).body.attraction.slug);
        expect(slugs).toEqual(['bijli-mahadev', 'bijli-mahadev-kullu', 'bijli-mahadev-2']);
      });
      it('201 with the photo credited when a Commons image is supplied', async () => {
        const res = await create(valid({ commonsImage: 'File:Bijli.jpg' })).expect(201);
        expect(res.body).toMatchObject({ message: 'Place added.', attraction: { imageUrl: commonsResult!.url, imageCredit: commonsResult!.credit } });
      });
      it('201 but warns (as the message) when the Commons file cannot be used', async () => {
        commonsResult = null;
        const res = await create(valid({ commonsImage: 'File:Bad.jpg' })).expect(201);
        expect(res.body.message).toBe('Saved without a photo: that Commons file could not be used.');
        expect(res.body.attraction.imageUrl).toBeNull();
      });
      it.each([
        ['missing body', {}, /name/],
        ['short name', { name: 'A' }, /Name is too short/],
        ['bad category', { category: 'spa' }, /Pick a category/],
        ['non-HP district', { district: 'Delhi' }, /Pick a Himachal district/],
        ['latitude north of HP', { lat: 40 }, /Latitude must be inside Himachal/],
        ['latitude south of HP', { lat: 10 }, /lat: /],
        ['longitude outside HP', { lng: 100 }, /Longitude must be inside Himachal/],
        ['non-numeric lat', { lat: 'north' }, /lat/],
        ['bad difficulty', { difficulty: 'insane' }, /difficulty/],
        ['too many videos', { youtubeIds: Array(7).fill('dQw4w9WgXcQ') }, /at most 6 videos/],
        ['not a youtube video', { youtubeIds: ['https://example.com/x'] }, /Not a YouTube video/],
        ['popularity out of range', { popularity: 101 }, /popularity/],
        ['bad status', { status: 'deleted' }, /status/],
      ])('400 on %s', async (_l, over, msg) => {
        const body = _l === 'missing body' ? over : valid(over);
        const res = await create(body);
        failureShape(res, 400);
        expect(res.body.message).toMatch(msg);
        expect(A.rows).toHaveLength(0);
      });
    });

    describe('PATCH :id', () => {
      let id: string;
      beforeEach(async () => {
        admin();
        id = (await A.seed({ name: 'Old Name', district: 'Mandi', status: 'draft' })).id;
      });
      const patch = (i: string, b: any) => http().patch(`${base}/${i}`).set('Cookie', adm()).send(b);

      it('200 applies a partial update and publishes to the public API', async () => {
        const res = await patch(id, { name: 'New Name', status: 'published', popularity: '80', tehsil: '' }).expect(200);
        expect(res.body).toMatchObject({ success: true, message: 'Place updated.', attraction: { id, name: 'New Name', status: 'published', popularity: 80, tehsil: null, district: 'Mandi' } });
        expect((await http().get('/api/attractions').query({ district: 'Mandi' })).body.attractions.map((a: any) => a.name)).toEqual(['New Name']);
      });
      it('200 with an empty body leaves the row unchanged', async () => {
        const res = await patch(id, {}).expect(200);
        expect(res.body.attraction).toMatchObject({ name: 'Old Name', status: 'draft' });
      });
      it('200 reports a photo warning as the message', async () => {
        commonsResult = null;
        const res = await patch(id, { commonsImage: 'File:Nope.jpg' }).expect(200);
        expect(res.body.message).toBe('The photo was not changed: that Commons file could not be used.');
      });
      it('404 for an unknown id', async () => {
        const res = await patch('does-not-exist', { name: 'Whatever' });
        failureShape(res, 404);
        expect(res.body.message).toBe('Attraction not found');
      });
      it.each([
        [{ name: 'A' }, /Name is too short/],
        [{ district: 'Delhi' }, /Pick a Himachal district/],
        [{ lat: 99 }, /Latitude/],
        [{ status: 'nope' }, /status/],
      ])('400 on invalid update %j and the row stays as it was', async (b, msg) => {
        const res = await patch(id, b);
        failureShape(res, 400);
        expect(res.body.message).toMatch(msg);
        expect(A.rows[0].name).toBe('Old Name');
      });
    });

    describe('DELETE :id', () => {
      beforeEach(() => void admin());
      const del = (i: string) => http().delete(`${base}/${i}`).set('Cookie', adm());

      it('200 deletes a manual place and it disappears from the public API', async () => {
        const row = await A.seed({ name: 'Doomed', district: 'Una', status: 'published' });
        expect((await http().get('/api/attractions').query({ district: 'Una' })).body.attractions).toHaveLength(1);
        const res = await del(row.id).expect(200);
        expect(res.body).toMatchObject({ success: true, message: 'Place deleted.', id: row.id });
        expect(A.rows).toHaveLength(0);
        expect((await http().get('/api/attractions').query({ district: 'Una' })).body.attractions).toHaveLength(0);
      });
      it('404 for an unknown id', async () => {
        failureShape(await del('nope'), 404);
      });
      it('400 for an imported (wikidata) place, which must be hidden instead', async () => {
        const row = await A.seed({ name: 'Imported', source: 'wikidata', source_id: 'Q1' });
        const res = await del(row.id);
        failureShape(res, 400);
        expect(res.body.message).toMatch(/Imported places cannot be deleted/);
        expect(A.rows).toHaveLength(1);
      });
    });
  });
});
