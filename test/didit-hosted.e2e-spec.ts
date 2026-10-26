import * as http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { ResponseMessageInterceptor } from '../src/common/interceptors/response-message.interceptor';
import { AuthGuard } from '../src/auth/auth.guard';
import { StorageService } from '../src/storage/storage.service';
import { DiditController } from '../src/verification/didit.controller';
import { DiditService, signWebhookBody } from '../src/verification/didit.service';
import { VerificationController } from '../src/verification/verification.controller';
import { VerificationService } from '../src/verification/verification.service';
import { assertKycVerified } from '../src/user/verification-gate.util';
import { UserEntity, VerificationAuditLogEntity, VerificationRequestEntity } from '../src/entities';

const USER = '11111111-1111-4111-8111-111111111111';
const API_KEY = 'didit_key_SECRET_999';
const WH_SECRET = 'whsec_SECRET_777';
const GENERIC = 'Verification service is temporarily unavailable. Please try again.';
const nowS = () => Math.floor(Date.now() / 1000);

type Seen = { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: any };
function startDidit(handler: (s: Seen) => { status: number; body?: unknown; delayMs?: number }) {
  const calls: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const seen: Seen = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      calls.push(seen);
      const { status, body, delayMs } = handler(seen);
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
      }, delayMs ?? 0);
    });
  });
  return new Promise<{ url: string; calls: Seen[]; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        calls,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      }),
    ),
  );
}

function makeStore() {
  const rows: Record<string, any>[] = [];
  const audit: Record<string, any>[] = [];
  let seq = 0;
  const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
  const requests = {
    findOne: async ({ where, order }: any) => {
      const m = rows.filter((r) => match(r, where));
      if (order) m.sort((a, b) => b.submitted_at - a.submitted_at || b.seq - a.seq);
      return m[0] ?? null;
    },
    create: (r: any) => ({ reviewed_at: null, reviewed_by: null, rejection_reason: null, document_path: null, document_path_back: null, submitted_at: new Date(), ...r }),
    save: async (r: any) => { r.id = r.id ?? `row-${++seq}`; r.seq = seq; rows.push(r); return r; },
    update: async (where: any, patch: any) => { rows.filter((r) => match(r, where)).forEach((r) => Object.assign(r, patch)); },
  };
  const profile: Record<string, any> = { id: USER, full_name: 'Asha Rao', selfie_uploaded_at: null };
  const profiles = {
    findOne: async ({ where }: any) => (where.id === USER ? { ...profile } : null),
    update: async (_w: any, patch: any) => Object.assign(profile, patch),
  };
  const auditLog = { create: (x: any) => x, save: async (x: any) => audit.push(x) };
  return { rows, audit, requests, profile, profiles, auditLog };
}

const decision = (idv: Record<string, unknown> = { full_name: 'Asha Kumari Rao' }, extra: Record<string, unknown> = {}) => ({
  id_verifications: [{ status: 'Approved', warnings: [], ...idv }],
  liveness_checks: [{ status: 'Approved', score: 98.0, warnings: [] }],
  face_matches: [{ status: 'Approved', score: 90.5, warnings: [] }],
  reviews: [],
  ...extra,
});

describe('Didit hosted KYC (session + signed webhook, fake Didit, in-memory DB)', () => {
  let app: INestApplication;
  let didit: Awaited<ReturnType<typeof startDidit>>;
  let store: ReturnType<typeof makeStore>;
  let handler: (s: Seen) => { status: number; body?: unknown; delayMs?: number };
  let env: Record<string, any>;

  beforeEach(async () => {
    handler = () => ({ status: 201, body: { session_id: 'sess-1', session_token: 'tok', url: 'https://verify.didit.me/s/sess-1', status: 'Not Started' } });
    didit = await startDidit((s) => handler(s));
    store = makeStore();
    env = {
      DIDIT_API_KEY: API_KEY,
      DIDIT_WORKFLOW_ID: 'wf-123',
      DIDIT_WEBHOOK_SECRET: WH_SECRET,
      DIDIT_BASE_URL: didit.url,
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [VerificationController, DiditController],
      providers: [
        VerificationService,
        DiditService,
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: StorageService, useValue: {} },
        { provide: getRepositoryToken(VerificationRequestEntity), useValue: store.requests },
        { provide: getRepositoryToken(VerificationAuditLogEntity), useValue: store.auditLog },
        { provide: getRepositoryToken(UserEntity), useValue: store.profiles },
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          if (!req.headers['x-test-user']) throw new UnauthorizedException('No session');
          req.user = { userId: USER };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await didit.close();
  });

  const session = (auth = true) => {
    const r = request(app.getHttpServer()).post('/api/verification/didit/session');
    return auth ? r.set('x-test-user', '1') : r;
  };
  const event = (status: string, over: Record<string, unknown> = {}) => ({
    event_id: `evt-${Math.random()}`,
    webhook_type: 'status.updated',
    timestamp: nowS(),
    created_at: new Date().toISOString(),
    application_id: 'app-1',
    environment: 'sandbox',
    session_id: 'sess-1',
    status,
    workflow_id: 'wf-123',
    workflow_version: 1,
    vendor_data: USER,
    metadata: {},
    decision: decision(),
    ...over,
  });
  const sign = (b: unknown, secret = WH_SECRET) => signWebhookBody(b, secret);
  const hook = (b: unknown, sig: string | null = sign(b)) => {
    const r = request(app.getHttpServer()).post('/api/verification/didit/webhook').send(b as any);
    return sig === null ? r : r.set('X-Signature-V2', sig);
  };
  const latest = (type: string) => [...store.rows].reverse().find((r) => r.verification_type === type);
  const statusOf = async () => (await request(app.getHttpServer()).get('/api/verification/status').set('x-test-user', '1').expect(200)).body;

  describe('POST /api/verification/didit/session', () => {
    it('creates a session with the right request and returns {sessionId, url}', async () => {
      const res = await session().expect(201);
      expect(res.body).toMatchObject({ success: true, sessionId: 'sess-1', url: 'https://verify.didit.me/s/sess-1' });
      const c = didit.calls[0];
      expect(c.method).toBe('POST');
      expect(c.url).toBe('/v3/session/');
      expect(c.headers['x-api-key']).toBe(API_KEY);
      expect(c.body).toMatchObject({ workflow_id: 'wf-123', vendor_data: USER });
      expect(c.body).not.toHaveProperty('callback');
      expect(c.body).not.toHaveProperty('sandbox_scenario');
    });

    it('sends callback and sandbox_scenario only when configured', async () => {
      env.DIDIT_CALLBACK_URL = 'https://app.test/done';
      env.DIDIT_SANDBOX_SCENARIO = 'Approved';
      await session().expect(201);
      expect(didit.calls[0].body).toMatchObject({ callback: 'https://app.test/done', sandbox_scenario: 'Approved' });
    });

    it('401 without a session', async () => {
      await session(false).expect(401);
      expect(didit.calls).toHaveLength(0);
    });

    it('409 when identity and selfie are both already verified', async () => {
      await hook(event('Approved')).expect(200);
      await session().expect(409);
      expect(didit.calls).toHaveLength(0);
    });

    it.each([['DIDIT_API_KEY'], ['DIDIT_WORKFLOW_ID']])('503 when %s is missing', async (key) => {
      env[key] = '';
      const res = await session().expect(503);
      expect(res.body.message).toBe(GENERIC);
      expect(didit.calls).toHaveLength(0);
    });

    it.each([403, 401, 429, 500, 502])('upstream %i is a generic 503 with no leaks', async (status) => {
      handler = () => ({ status, body: { detail: `insufficient credits ${API_KEY} ${WH_SECRET}` } });
      const res = await session().expect(503);
      expect(JSON.stringify(res.body)).toContain(GENERIC);
      expect(JSON.stringify(res.body)).not.toMatch(/credits|SECRET/);
    });

    it('a 201 without session_id/url is a 503', async () => {
      handler = () => ({ status: 201, body: { status: 'Not Started' } });
      await session().expect(503);
    });

    it('a timeout is a 503', async () => {
      (app.get(DiditService) as DiditService).timeoutMs = 100;
      handler = () => ({ status: 201, body: {}, delayMs: 600 });
      const res = await session().expect(503);
      expect(res.body.message).toBe(GENERIC);
    });
  });

  describe('POST /api/verification/didit/webhook', () => {
    it('400 on a non-object body', async () => {
      await request(app.getHttpServer()).post('/api/verification/didit/webhook').send([1, 2]).expect(400);
      await request(app.getHttpServer()).post('/api/verification/didit/webhook').set('Content-Type', 'application/json').send('"str"').expect(400);
    });

    it('503 when the webhook secret is missing', async () => {
      env.DIDIT_WEBHOOK_SECRET = '';
      await hook(event('Approved'), 'abc').expect(503);
    });

    it('401 for a missing, wrong-length, wrong, tampered or stale signature (nothing written)', async () => {
      const b = event('Approved');
      await hook(b, null).expect(401);
      await hook(b, 'abc').expect(401);
      await hook(b, sign(b, 'other-secret')).expect(401);
      await hook({ ...b, status: 'Declined' }, sign(b)).expect(401);
      const stale = event('Approved', { timestamp: nowS() - 301 });
      await hook(stale).expect(401);
      const future = event('Approved', { timestamp: nowS() + 301 });
      await hook(future).expect(401);
      expect(store.rows).toHaveLength(0);
    });

    it('400 when the signed body lacks session_id or status', async () => {
      const { session_id, ...noSession } = event('Approved');
      await hook(noSession).expect(400);
      const { status, ...noStatus } = event('Approved');
      await hook(noStatus).expect(400);
      expect(store.rows).toHaveLength(0);
    });

    it('Approved writes identity + selfie verified, sets the selfie timestamp and passes the real gate', async () => {
      const b = event('Approved');
      const res = await hook(b).expect(200);
      expect(res.body).toMatchObject({ success: true });
      for (const type of ['identity', 'selfie']) {
        expect(latest(type)).toMatchObject({ user_id: USER, status: 'verified', document_subtype: 'didit', reviewed_by: null, rejection_reason: null });
        expect(latest(type)!.reviewed_at).toBeInstanceOf(Date);
        expect(latest(type)!.analysis_result).toMatchObject({ source: 'didit', provider: 'didit', sessionId: 'sess-1', status: 'Approved', eventTimestamp: b.timestamp, eventId: b.event_id, nameMatched: true });
      }
      expect(store.profile.selfie_uploaded_at).toBeInstanceOf(Date);
      expect(store.audit).toHaveLength(2);

      const status = await statusOf();
      expect(status).toMatchObject({ identity: { status: 'verified' }, selfie: { status: 'verified' } });
      expect(status).not.toHaveProperty('kycProvider');
      expect(() => assertKycVerified(store.profile as any, { identity: { status: status.identity.status } })).not.toThrow();
    });

    it('name absent in the payload skips the name check', async () => {
      await hook(event('Approved', { decision: decision({ full_name: undefined }) })).expect(200);
      expect(latest('identity')!.status).toBe('verified');
      expect(latest('identity')!.analysis_result).not.toHaveProperty('nameMatched');
    });

    it('uses first_name + last_name when full_name is absent', async () => {
      await hook(event('Approved', { decision: decision({ full_name: undefined, first_name: 'Asha', last_name: 'Rao' }) })).expect(200);
      expect(latest('identity')!.status).toBe('verified');
    });

    it('a name mismatch is a rejection with the fixed reason and no selfie timestamp', async () => {
      await hook(event('Approved', { decision: decision({ full_name: 'Someone Else' }) })).expect(200);
      for (const type of ['identity', 'selfie']) {
        expect(latest(type)).toMatchObject({ status: 'rejected', rejection_reason: 'The name on your ID does not match the name on your profile.' });
        expect(latest(type)!.analysis_result).toMatchObject({ nameMatched: false });
      }
      expect(store.profile.selfie_uploaded_at).toBeNull();
      expect(() => assertKycVerified(store.profile as any, { identity: { status: 'rejected' } })).toThrow();
    });

    it.each([
      ['DOCUMENT_EXPIRED', /expired/],
      ['POSSIBLE_SCREEN_CAPTURE', /physical card/],
      ['LOW_FACE_MATCH_SIMILARITY', /did not match/],
      ['LIVENESS_FAILED', /live selfie/],
      ['WEIRD_TAG', /^Your verification could not be completed\. Please try again\.$/],
    ])('Declined with %s gives a friendly fixed reason, never raw text', async (risk, re) => {
      const dec = decision({ warnings: [{ risk, log_type: 'error', short_description: 'RAW PROVIDER TEXT', long_description: 'RAW LONG' }] });
      await hook(event('Declined', { decision: dec })).expect(200);
      for (const type of ['identity', 'selfie']) {
        expect(latest(type)).toMatchObject({ status: 'rejected', reviewed_by: null });
        expect(latest(type)!.rejection_reason).toMatch(re);
      }
      expect(JSON.stringify(store.rows)).not.toMatch(/RAW/);
      expect(JSON.stringify(await statusOf())).not.toMatch(/RAW/);
    });

    it('Declined with no tags gives the generic sentence', async () => {
      await hook(event('Declined', { decision: undefined })).expect(200);
      expect(latest('identity')!.rejection_reason).toBe('Your verification could not be completed. Please try again.');
    });

    it.each(['In Review', 'Resubmitted'])('%s writes pending rows (new, since none exist)', async (st) => {
      await hook(event(st)).expect(200);
      expect(latest('identity')!.status).toBe('pending');
      expect(latest('selfie')!.status).toBe('pending');
      expect(store.profile.selfie_uploaded_at).toBeNull();
    });

    it('In Review then Approved updates the pending row in place', async () => {
      await hook(event('In Review', { timestamp: nowS() - 10 })).expect(200);
      expect(store.rows).toHaveLength(2);
      const ids = store.rows.map((r) => r.id);
      await hook(event('Approved')).expect(200);
      expect(store.rows).toHaveLength(2);
      expect(store.rows.map((r) => r.id)).toEqual(ids);
      expect(store.rows.every((r) => r.status === 'verified')).toBe(true);
    });

    it('a rejected row is kept as history: a later Approved adds a NEW row', async () => {
      await hook(event('Declined', { timestamp: nowS() - 10 })).expect(200);
      await hook(event('Approved')).expect(200);
      expect(store.rows).toHaveLength(4);
      expect(store.rows.filter((r) => r.status === 'rejected')).toHaveLength(2);
      expect(latest('identity')!.status).toBe('verified');
    });

    it.each(['Abandoned', 'Expired', 'Not Started', 'In Progress', 'Awaiting User', 'Kyc Expired', 'Whatever New'])('%s is a 200 no-op', async (st) => {
      await hook(event(st)).expect(200);
      expect(store.rows).toHaveLength(0);
    });

    it('an unknown user is a 200 no-op', async () => {
      await hook(event('Approved', { vendor_data: '22222222-2222-4222-8222-222222222222' })).expect(200);
      await hook(event('Approved', { vendor_data: 'not-a-uuid' })).expect(200);
      expect(store.rows).toHaveLength(0);
    });

    it('a replayed event is idempotent', async () => {
      const b = event('Approved');
      await hook(b).expect(200);
      await hook(b).expect(200);
      expect(store.rows).toHaveLength(2);
      expect(store.audit).toHaveLength(2);
    });

    it('a stale event never downgrades Approved', async () => {
      await hook(event('Approved')).expect(200);
      await hook(event('Declined', { timestamp: nowS() - 60 })).expect(200);
      await hook(event('In Review', { timestamp: nowS() - 60 })).expect(200);
      expect(store.rows).toHaveLength(2);
      expect(store.rows.every((r) => r.status === 'verified')).toBe(true);
    });

    it('an older event for the same session does not replace a newer pending state', async () => {
      await hook(event('Declined', { timestamp: nowS() - 5 })).expect(200);
      await hook(event('In Review', { timestamp: nowS() - 60 })).expect(200);
      expect(latest('identity')!.status).toBe('rejected');
    });
  });
});
