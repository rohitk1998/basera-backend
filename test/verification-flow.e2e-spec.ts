import * as http from 'http';
import { AddressInfo } from 'net';
import Busboy from 'busboy';
import request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { ResponseMessageInterceptor } from '../src/common/interceptors/response-message.interceptor';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthGuard } from '../src/auth/auth.guard';
import { CashfreeService } from '../src/payments/cashfree.service';
import { StorageService } from '../src/storage/storage.service';
import { DocumentAnalysisService } from '../src/verification/document-analysis.service';
import { VerificationController } from '../src/verification/verification.controller';
import { VerificationService } from '../src/verification/verification.service';
import { UserEntity, VerificationAuditLogEntity, VerificationRequestEntity } from '../src/entities';

/* ── A stand-in for Cashfree that parses real multipart / JSON bodies ──────── */

type Seen = { path: string; json?: any; fields: Record<string, string>; fileText?: string };

function startCashfree(handler: (seen: Seen) => { status: number; body: unknown }) {
  const calls: Seen[] = [];
  const server = http.createServer((req, res) => {
    const seen: Seen = { path: (req.url ?? '').replace('/verification', ''), fields: {} };
    const finish = () => {
      calls.push(seen);
      const { status, body } = handler(seen);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if ((req.headers['content-type'] ?? '').startsWith('multipart/')) {
      const bb = Busboy({ headers: req.headers });
      bb.on('field', (k, v) => (seen.fields[k] = v));
      bb.on('file', (_k, stream) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => (seen.fileText = Buffer.concat(chunks).toString()));
      });
      bb.on('close', finish);
      req.pipe(bb);
    } else {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.json = raw ? JSON.parse(raw) : undefined;
        finish();
      });
    }
  });
  return new Promise<{ url: string; calls: Seen[]; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/verification`,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

/** What the fake OCR says for a file whose bytes are the given marker text. */
const CLEAN_FLAGS = { blur: false, glare: false, partially_present: false, black_and_white: false, face_present: true, face_clear: true, qr_present: true, obscured: false };
const CLEAN_FRAUD = { is_screenshot: false, is_photo_of_screen: false, is_photo_imposed: false, is_overwritten: false, is_forged: false };
function ocr(marker: string): { status: number; body: unknown } {
  const isFront = marker.startsWith('front');
  const qr = { status: marker.includes('primitive') ? 'PRIMITIVE' : 'SECURE', name: 'Asha Kumari Rao', aadhaar_last_four_digit: '5647', photo_link: 'PHOTO', mobile_hash: 'H' };
  return {
    status: 200,
    body: {
      reference_id: isFront ? 1 : 2,
      status: 'VALID',
      document_type: isFront ? 'AADHAAR_FRONT' : 'AADHAAR_BACK',
      document_fields: isFront ? { uid: '123456785647', name: 'Asha Kumari Rao', dob: '1990-01-01', address: 'PRIVATE ADDRESS' } : { address: 'PRIVATE ADDRESS' },
      quality_checks: CLEAN_FLAGS,
      fraud_checks: { ...CLEAN_FRAUD, is_screenshot: marker.includes('screenshot') },
      qr_details: qr,
    },
  };
}

/* ── In-memory stand-ins for the database and storage ──────────────────────── */

function makeStore() {
  const rows: Record<string, any>[] = [];
  const audit: Record<string, any>[] = [];
  let seq = 0;
  const requests = {
    findOne: async ({ where, order }: any) => {
      const m = rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      if (order) m.sort((a, b) => b.submitted_at - a.submitted_at || b.seq - a.seq);
      return m[0] ?? null;
    },
    findOneOrFail: async ({ where }: any) => rows.find((r) => r.id === where.id),
    create: (r: any) => ({ reviewed_at: null, reviewed_by: null, rejection_reason: null, document_path: null, document_path_back: null, submitted_at: new Date(), ...r }),
    save: async (r: any) => {
      r.id = r.id ?? `row-${++seq}`;
      r.seq = seq;
      rows.push(r);
      return r;
    },
    update: async (where: any, patch: any) => {
      rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)).forEach((r) => Object.assign(r, patch));
    },
    // Counts the rows the daily-cap rule counts: this user's, this type, rejected, not by an admin, not "replaced by".
    count: async ({ where }: any) =>
      rows.filter((r) => r.user_id === where.user_id && r.verification_type === where.verification_type && r.status === 'rejected' && !r.reviewed_by && !String(r.rejection_reason).startsWith('Replaced by')).length,
  };
  const profile: Record<string, any> = { id: 'u1', full_name: 'Asha Rao', pan: null, bank_upi: null, bank_verified_at: null, selfie_uploaded_at: null };
  const profiles = {
    findOne: async () => ({ ...profile }),
    update: async (_w: any, patch: any) => Object.assign(profile, patch),
  };
  const auditLog = { create: (x: any) => x, save: async (x: any) => audit.push(x) };
  return { rows, audit, requests, profile, profiles, auditLog };
}

describe('Verification flow (HTTP, real controller + service + Cashfree client, fake Cashfree/DB/storage)', () => {
  let app: INestApplication;
  let cashfree: Awaited<ReturnType<typeof startCashfree>>;
  let store: ReturnType<typeof makeStore>;
  let cfHandler: (s: Seen) => { status: number; body: unknown };

  // The default is admin review; most Aadhaar tests below cover the Cashfree Smart OCR path.
  let aadhaarMode: 'admin' | 'cashfree';

  beforeEach(async () => {
    aadhaarMode = 'cashfree';
    cfHandler = (s) => (s.path === '/bharat-ocr' ? ocr(s.fileText ?? '') : { status: 404, body: {} });
    cashfree = await startCashfree((s) => cfHandler(s));
    store = makeStore();

    const moduleRef = await Test.createTestingModule({
      controllers: [VerificationController],
      providers: [
        VerificationService,
        CashfreeService,
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: DocumentAnalysisService, useValue: { analyze: async () => ({ readable: true }) } },
        { provide: StorageService, useValue: { uploadVerificationDocument: async (_u: string, kind: string) => ({ path: `u1/${kind}/file.jpg` }) } },
        { provide: getRepositoryToken(VerificationRequestEntity), useValue: store.requests },
        { provide: getRepositoryToken(VerificationAuditLogEntity), useValue: store.auditLog },
        { provide: getRepositoryToken(UserEntity), useValue: store.profiles },
        {
          provide: ConfigService,
          useValue: { get: (k: string) => ({ CASHFREE_CLIENT_ID: 'cid', CASHFREE_CLIENT_SECRET: 'sec', CASHFREE_VERIFICATION_BASE_URL: cashfree.url, AADHAAR_VERIFICATION_MODE: aadhaarMode })[k] },
        },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: (ctx: any) => ((ctx.switchToHttp().getRequest().user = { userId: 'u1' }), true) })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await cashfree.close();
  });

  const upload = (frontText: string, backText: string, path = '/api/verification/identity', opts: { frontType?: string; backType?: string; skipBack?: boolean; frontBuf?: Buffer } = {}) => {
    let r = request(app.getHttpServer())
      .post(path)
      .field('documentSubtype', 'aadhaar')
      .attach('file', opts.frontBuf ?? Buffer.from(frontText), { filename: 'front.jpg', contentType: opts.frontType ?? 'image/jpeg' });
    if (!opts.skipBack) r = r.attach('fileBack', Buffer.from(backText), { filename: 'back.jpg', contentType: opts.backType ?? 'image/jpeg' });
    return r;
  };

  /* ── Aadhaar ─────────────────────────────────────────────────────────── */

  describe('Aadhaar upload', () => {
    it('verifies a clean, UIDAI-signed card on the spot and keeps no personal data', async () => {
      const res = await upload('front-clean', 'back-clean').expect(201);
      expect(res.body).toMatchObject({ success: true, message: 'Aadhaar verified.' });
      expect(res.body.identity).toMatchObject({ status: 'verified', hasBackDocument: true });

      const row = store.rows[0];
      expect(row).toMatchObject({ status: 'verified', verification_type: 'identity', document_subtype: 'aadhaar', document_path: 'u1/identity/file.jpg', document_path_back: 'u1/identity-back/file.jpg' });
      expect(row.reviewed_at).toBeInstanceOf(Date);
      expect(row.reviewed_by).toBeNull();
      expect(row.analysis_result).toMatchObject({ source: 'cashfree-smart-ocr', qrStatus: 'SECURE', uidLast4: '5647' });
      const stored = JSON.stringify(row);
      expect(stored).not.toMatch(/123456785647|PRIVATE ADDRESS|PHOTO/);
      expect(store.audit).toHaveLength(1);
      // Both sides were sent to Cashfree, each as its own request.
      expect(cashfree.calls.filter((c) => c.path === '/bharat-ocr')).toHaveLength(2);
    });

    it('accepts the sides uploaded in the wrong order', async () => {
      const res = await upload('back-clean', 'front-clean').expect(201);
      expect(res.body.identity.status).toBe('verified');
    });

    it('rejects a screenshot with a clear reason the user can act on', async () => {
      const res = await upload('front-screenshot', 'back-clean').expect(201);
      expect(res.body.identity.status).toBe('rejected');
      expect(res.body.identity.rejectionReason).toMatch(/screenshot/);
      // The message the user sees is the reason itself, not a generic "success".
      expect(res.body.message).toBe(res.body.identity.rejectionReason);
      expect(store.rows[0]).toMatchObject({ status: 'rejected' });
    });

    it('rejects an unsigned (old-style) QR with what to do about it — no admin is involved', async () => {
      const res = await upload('front-primitive', 'back-primitive').expect(201);
      expect(res.body.identity.status).toBe('rejected');
      expect(res.body.identity.rejectionReason).toMatch(/e-Aadhaar/);
      expect(store.rows[0]).toMatchObject({ status: 'rejected' });
      expect(store.rows.some((r) => r.status === 'pending')).toBe(false);
    });

    it.each([
      ['Cashfree is down (500)', 500, { code: 'verification_failed' }],
      ['the IP is not whitelisted (403)', 403, { code: 'ip_validation_failed' }],
      ['the balance is empty (422)', 422, { code: 'insufficient_balance' }],
      ['the product is not enabled on the account (400)', 400, { code: 'invalid_request', message: 'Verification Suite is not enabled for this account' }],
    ])('answers 503 "try again later" when %s — and stores nothing and costs the user no attempt', async (_label, status, body) => {
      cfHandler = () => ({ status, body });
      const res = await upload('front-clean', 'back-clean').expect(503);
      expect(res.body.message).toMatch(/temporarily unavailable|try again/i);
      expect(store.rows).toHaveLength(0);
      expect(store.audit).toHaveLength(0);
    });

    it('is not held against the user: after an outage the very next try can verify', async () => {
      cfHandler = () => ({ status: 500, body: {} });
      await upload('front-clean', 'back-clean').expect(503);
      cfHandler = (s) => ocr(s.fileText ?? '');
      expect((await upload('front-clean', 'back-clean').expect(201)).body.identity.status).toBe('verified');
    });

    it('rejects with a retake message when Cashfree refuses the file itself', async () => {
      cfHandler = () => ({ status: 400, body: { code: 'file_type_invalid', message: 'bad' } });
      const res = await upload('front-clean', 'back-clean').expect(201);
      expect(res.body.identity).toMatchObject({ status: 'rejected' });
      expect(res.body.identity.rejectionReason).toMatch(/could not read this file/i);
    });

    it('needs both sides (400) and never calls Cashfree without them', async () => {
      const res = await upload('front-clean', '', '/api/verification/identity', { skipBack: true }).expect(400);
      expect(res.body.message).toMatch(/back side/);
      expect(res.body).toMatchObject({ success: false, statusCode: 400, error: res.body.message });
      expect(cashfree.calls).toHaveLength(0);
      expect(store.rows).toHaveLength(0);
    });

    it('refuses file types Cashfree cannot read (webp) before spending a call', async () => {
      const res = await upload('front-clean', 'back-clean', '/api/verification/identity', { frontType: 'image/webp' }).expect(400);
      expect(res.body.message).toMatch(/JPEG, PNG or PDF/);
      expect(cashfree.calls).toHaveLength(0);
    });

    it('refuses files over 5 MB with a 413', async () => {
      const res = await upload('', 'back-clean', '/api/verification/identity', { frontBuf: Buffer.alloc(6 * 1024 * 1024, 1) }).expect(413);
      expect(res.body.message).toMatch(/5 MB/);
      expect(cashfree.calls).toHaveLength(0);
    });

    it('needs a full name on the profile first', async () => {
      store.profile.full_name = null;
      const res = await upload('front-clean', 'back-clean').expect(400);
      expect(res.body.message).toMatch(/full name/);
      expect(cashfree.calls).toHaveLength(0);
    });

    it('refuses a second submission once verified', async () => {
      await upload('front-clean', 'back-clean').expect(201);
      await upload('front-clean', 'back-clean').expect(409);
    });

    it('lets a rejected user resubmit and get verified', async () => {
      await upload('front-screenshot', 'back-clean').expect(201);
      const res = await upload('front-clean', 'back-clean', '/api/verification/identity/resubmit').expect(201);
      expect(res.body.identity.status).toBe('verified');
    });

    it('locks after 5 real failures in a day (429), without a single extra Cashfree call', async () => {
      for (let i = 0; i < 5; i++) {
        const path = i === 0 ? '/api/verification/identity' : '/api/verification/identity/resubmit';
        expect((await upload('front-screenshot', 'back-clean', path).expect(201)).body.identity.status).toBe('rejected');
      }
      const callsBefore = cashfree.calls.length;
      const res = await upload('front-clean', 'back-clean', '/api/verification/identity/resubmit').expect(429);
      expect(res.body.message).toMatch(/Too many failed/);
      expect(cashfree.calls.length).toBe(callsBefore);
    });

    it('shows the status through GET /status', async () => {
      await upload('front-clean', 'back-clean').expect(201);
      const res = await request(app.getHttpServer()).get('/api/verification/status').expect(200);
      expect(res.body.identity).toMatchObject({ status: 'verified', documentSubtype: 'aadhaar', hasBackDocument: true });
      expect(res.body.pan.status).toBe('not_started');
    });
  });

  describe('Aadhaar upload — admin review mode', () => {
    // The ConfigService stub reads aadhaarMode per call, so switching it here applies to the running app.
    beforeEach(() => {
      aadhaarMode = 'admin';
    });

    it('stores both sides as pending for an admin and calls no third party', async () => {
      const res = await upload('front-clean', 'back-clean').expect(201);
      expect(res.body).toMatchObject({ success: true, message: 'Aadhaar submitted for review.' });
      expect(res.body.identity).toMatchObject({ status: 'pending', hasBackDocument: true });

      expect(store.rows).toHaveLength(1);
      expect(store.rows[0]).toMatchObject({
        status: 'pending',
        verification_type: 'identity',
        document_subtype: 'aadhaar',
        document_path: 'u1/identity/file.jpg',
        document_path_back: 'u1/identity-back/file.jpg',
      });
      expect(store.rows[0].reviewed_at).toBeNull();
      expect(store.audit).toHaveLength(1);
      expect(cashfree.calls).toHaveLength(0);
    });

    it('needs no profile name — an admin compares the name by eye', async () => {
      store.profile.full_name = null;
      await upload('front-clean', 'back-clean').expect(201);
      expect(store.rows[0].status).toBe('pending');
    });

    it('still refuses a missing back side, a wrong file type, and an oversize file', async () => {
      await upload('front-clean', '', '/api/verification/identity', { skipBack: true }).expect(400);
      await upload('front-clean', 'back-clean', '/api/verification/identity', { frontType: 'image/webp' }).expect(400);
      await upload('', 'back-clean', '/api/verification/identity', { frontBuf: Buffer.alloc(6 * 1024 * 1024, 1) }).expect(413);
      expect(store.rows).toHaveLength(0);
    });

    it('blocks a second submission while one is pending', async () => {
      await upload('front-clean', 'back-clean').expect(201);
      await upload('front-clean', 'back-clean').expect(409);
      expect(store.rows).toHaveLength(1);
    });

    it('lets a rejected user resubmit, and the status shows pending', async () => {
      store.rows.push({ id: 'r0', user_id: 'u1', verification_type: 'identity', status: 'rejected', reviewed_by: 'admin1', rejection_reason: 'Blurry', submitted_at: new Date(Date.now() - 1000), seq: -1 });
      const res = await upload('front-clean', 'back-clean', '/api/verification/identity/resubmit').expect(201);
      expect(res.body.identity.status).toBe('pending');
      const status = await request(app.getHttpServer()).get('/api/verification/status').expect(200);
      expect(status.body.identity).toMatchObject({ status: 'pending', hasBackDocument: true });
    });
  });

  /* ── PAN ─────────────────────────────────────────────────────────────── */

  describe('PAN', () => {
    const panOk = { reference_id: 7, valid: true, pan_status: 'VALID', registered_name: 'ASHA KUMARI RAO', name_match_result: 'GOOD_PARTIAL_MATCH' };
    const verifyPan = (body: object) => request(app.getHttpServer()).post('/api/verification/pan/verify').send(body);

    it('verifies a valid PAN with a matching name, saves it on the profile, and stores only the last 4', async () => {
      cfHandler = () => ({ status: 200, body: panOk });
      const res = await verifyPan({ pan: 'abcpv1234d' }).expect(201);
      expect(res.body).toMatchObject({ success: true, message: 'PAN verified.' });
      expect(res.body.pan.status).toBe('verified');
      expect(cashfree.calls[0]).toMatchObject({ path: '/pan', json: { pan: 'ABCPV1234D', name: 'Asha Rao' } });
      expect(store.profile.pan).toBe('ABCPV1234D');
      expect(JSON.stringify(store.rows[0])).not.toContain('ABCPV1234D');
      expect(store.rows[0].analysis_result).toMatchObject({ panLast4: '234D' });
    });

    it('rejects a PAN whose name does not match, with the reason, and does not touch the profile', async () => {
      cfHandler = () => ({ status: 200, body: { ...panOk, name_match_result: 'NO_MATCH' } });
      const res = await verifyPan({ pan: 'ABCPV1234D' }).expect(201);
      expect(res.body.pan).toMatchObject({ status: 'rejected' });
      expect(res.body.pan.rejectionReason).toMatch(/name/i);
      expect(res.body.message).toBe(res.body.pan.rejectionReason);
      expect(store.profile.pan).toBeNull();
    });

    it('rejects an invalid or inactive PAN', async () => {
      cfHandler = () => ({ status: 200, body: { valid: false, pan_status: 'INVALID' } });
      expect((await verifyPan({ pan: 'ABCPV1234D' }).expect(201)).body.pan.status).toBe('rejected');
    });

    it('rejects a badly formatted PAN (400) without calling Cashfree', async () => {
      await verifyPan({ pan: '12345' }).expect(400);
      expect(cashfree.calls).toHaveLength(0);
    });

    it('answers 503, not a rejection, while the Cashfree product is not enabled on the account', async () => {
      cfHandler = () => ({ status: 400, body: { code: 'invalid_request', message: 'Verification Suite is not enabled for this account' } });
      await verifyPan({ pan: 'ABCPV1234D' }).expect(503);
      expect(store.rows).toHaveLength(0);
      expect(store.profile.pan).toBeNull();
    });

    it('answers 503 (not a fake result) when Cashfree is unavailable', async () => {
      cfHandler = () => ({ status: 403, body: { code: 'ip_validation_failed' } });
      await verifyPan({ pan: 'ABCPV1234D' }).expect(503);
      expect(store.rows).toHaveLength(0);
    });

    it('refuses a second verification once verified', async () => {
      cfHandler = () => ({ status: 200, body: panOk });
      await verifyPan({ pan: 'ABCPV1234D' }).expect(201);
      const res = await verifyPan({ pan: 'ABCPV1234D' }).expect(409);
      expect(res.body).toMatchObject({ success: false, message: 'Your pan is already verified.', error: 'Your pan is already verified.' });
    });
  });

  /* ── Bank, UPI, selfie: same suite, quick end-to-end confirmation ───── */

  describe('Bank, UPI and selfie', () => {
    it('verifies a bank account and unlocks payouts', async () => {
      cfHandler = () => ({ status: 200, body: { account_status: 'VALID', name_at_bank: 'ASHA RAO', bank_name: 'HDFC Bank', name_match_result: 'DIRECT_MATCH', reference_id: 9 } });
      const res = await request(app.getHttpServer()).post('/api/verification/bank/verify').send({ accountHolderName: 'Asha Rao', accountNumber: '026291800001191', ifsc: 'hdfc0001234' }).expect(201);
      expect(res.body.bank).toMatchObject({ status: 'verified', bankName: 'HDFC Bank' });
      expect(cashfree.calls[0].json).toMatchObject({ bank_account: '026291800001191', ifsc: 'HDFC0001234' });
      expect(store.profile.bank_verified_at).toBeInstanceOf(Date);
    });

    it('rejects a bank account whose holder name does not match', async () => {
      cfHandler = () => ({ status: 200, body: { account_status: 'VALID', name_match_result: 'NO_MATCH' } });
      const res = await request(app.getHttpServer()).post('/api/verification/bank/verify').send({ accountHolderName: 'Asha Rao', accountNumber: '026291800001191', ifsc: 'HDFC0001234' }).expect(201);
      expect(res.body.bank.status).toBe('rejected');
      expect(store.profile.bank_verified_at).toBeNull();
    });

    it('verifies a UPI ID and saves it', async () => {
      cfHandler = () => ({ status: 200, body: { status: 'VALID', name_at_bank: 'ASHA RAO', name_match_result: 'DIRECT_MATCH', reference_id: 3 } });
      const res = await request(app.getHttpServer()).post('/api/verification/upi/verify').send({ vpa: 'Asha@okhdfc' }).expect(201);
      expect(res.body.upi).toEqual({ vpa: 'asha@okhdfc', nameAtBank: 'ASHA RAO' });
      expect(store.profile.bank_upi).toBe('asha@okhdfc');
      expect(cashfree.calls[0].json.user_consent).toMatchObject({ obtained: true, type: 'EXPLICIT' });
    });

    it('rejects an invalid UPI ID and leaves the profile alone', async () => {
      cfHandler = () => ({ status: 200, body: { status: 'INVALID' } });
      await request(app.getHttpServer()).post('/api/verification/upi/verify').send({ vpa: 'nobody@okhdfc' }).expect(400);
      expect(store.profile.bank_upi).toBeNull();
    });

    it('verifies a selfie with a live face', async () => {
      cfHandler = () => ({ status: 200, body: { status: 'SUCCESS', liveness: true, reference_id: 4 } });
      const res = await request(app.getHttpServer()).post('/api/verification/selfie/verify').attach('file', Buffer.from('selfie'), { filename: 's.jpg', contentType: 'image/jpeg' }).expect(201);
      expect(res.body.selfie.status).toBe('verified');
      expect(store.profile.selfie_uploaded_at).toBeInstanceOf(Date);
    });

    it('rejects a selfie with no live face', async () => {
      cfHandler = () => ({ status: 200, body: { status: 'REAL_FACE_NOT_DETECTED', liveness: false } });
      const res = await request(app.getHttpServer()).post('/api/verification/selfie/verify').attach('file', Buffer.from('selfie'), { filename: 's.jpg', contentType: 'image/jpeg' }).expect(201);
      expect(res.body.selfie.status).toBe('rejected');
      expect(store.profile.selfie_uploaded_at).toBeNull();
    });
  });
});
