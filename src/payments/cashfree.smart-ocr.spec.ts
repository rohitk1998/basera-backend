import * as http from 'http';
import { AddressInfo } from 'net';
import Busboy from 'busboy';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CashfreeService } from './cashfree.service';

type Captured = { path: string; headers: http.IncomingHttpHeaders; fields: Record<string, string>; file?: { name: string; type: string; size: number } };

/** A stand-in for Cashfree's /bharat-ocr: parses the real multipart body and replies with a scripted answer. */
function startFake(reply: (n: number, seen: Captured) => { status: number; body: unknown }) {
  const seen: Captured[] = [];
  const server = http.createServer((req, res) => {
    const cap: Captured = { path: req.url ?? '', headers: req.headers, fields: {} };
    const bb = Busboy({ headers: req.headers });
    bb.on('field', (k, v) => (cap.fields[k] = v));
    bb.on('file', (_k, stream, info) => {
      let size = 0;
      stream.on('data', (c: Buffer) => (size += c.length));
      stream.on('end', () => (cap.file = { name: info.filename, type: info.mimeType, size }));
    });
    bb.on('close', () => {
      seen.push(cap);
      const { status, body } = reply(seen.length, cap);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    req.pipe(bb);
  });
  return new Promise<{ url: string; seen: Captured[]; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/verification`,
        seen,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

const build = (url: string) =>
  new CashfreeService({
    get: (k: string) => ({ CASHFREE_CLIENT_ID: 'cid', CASHFREE_CLIENT_SECRET: 'csecret', CASHFREE_VERIFICATION_BASE_URL: url })[k],
  } as unknown as ConfigService);

const okBody = (type: string, over: Record<string, unknown> = {}) => ({
  verification_id: 'x',
  reference_id: 1358,
  status: 'VALID',
  document_type: type,
  document_fields: { uid: '123456789012', name: 'John Doe', dob: '2004-10-02', address: 'SECRET ADDRESS' },
  quality_checks: { blur: false, glare: false, face_present: true },
  fraud_checks: { is_screenshot: false, is_forged: null },
  qr_details: { status: 'SECURE', name: 'John Doe', aadhaar_last_four_digit: '9012', photo_link: 'BASE64', mobile_hash: 'h' },
  ...over,
});

const img = { image: Buffer.from('fake-jpeg-bytes'), mimetype: 'image/jpeg' };

describe('CashfreeService.readAadhaarImage (against a local fake Cashfree)', () => {
  let fake: Awaited<ReturnType<typeof startFake>>;
  afterEach(async () => fake?.close());

  it('posts multipart to /bharat-ocr with credentials, api version, unique id, type and the file', async () => {
    fake = await startFake(() => ({ status: 200, body: okBody('AADHAAR_FRONT') }));
    await build(fake.url).readAadhaarImage(img);

    const req = fake.seen[0];
    expect(req.path).toBe('/verification/bharat-ocr');
    expect(req.headers['x-client-id']).toBe('cid');
    expect(req.headers['x-client-secret']).toBe('csecret');
    expect(req.headers['x-api-version']).toBe('2024-12-01');
    expect(req.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(req.fields.document_type).toBe('AADHAAR');
    expect(req.fields.verification_id).toMatch(/^[A-Za-z0-9._-]{1,50}$/);
    expect(req.file).toMatchObject({ name: 'aadhaar.jpg', type: 'image/jpeg', size: img.image.length });
  });

  it('uses a different verification_id on every call', async () => {
    fake = await startFake(() => ({ status: 200, body: okBody('AADHAAR_FRONT') }));
    const cf = build(fake.url);
    await Promise.all([cf.readAadhaarImage(img), cf.readAadhaarImage(img)]);
    expect(fake.seen[0].fields.verification_id).not.toBe(fake.seen[1].fields.verification_id);
  });

  it('sends PDFs and PNGs with the right filename and type', async () => {
    fake = await startFake(() => ({ status: 200, body: okBody('AADHAAR_BACK') }));
    await build(fake.url).readAadhaarImage({ image: Buffer.from('%PDF-1.4'), mimetype: 'application/pdf' });
    await build(fake.url).readAadhaarImage({ image: Buffer.from('png'), mimetype: 'image/png' });
    expect(fake.seen[0].file).toMatchObject({ name: 'aadhaar.pdf', type: 'application/pdf' });
    expect(fake.seen[1].file).toMatchObject({ name: 'aadhaar.png', type: 'image/png' });
  });

  it('maps the response, keeping only what the evaluator needs', async () => {
    fake = await startFake(() => ({ status: 200, body: okBody('AADHAAR_FRONT') }));
    const out = await build(fake.url).readAadhaarImage(img);
    expect(out).toEqual({
      ok: true,
      result: {
        side: 'front',
        valid: true,
        referenceId: '1358',
        fields: { uid: '123456789012', name: 'John Doe', dob: '2004-10-02' },
        quality: { blur: false, glare: false, face_present: true },
        fraud: { is_screenshot: false, is_forged: null },
        qr: { status: 'SECURE', name: 'John Doe', lastFour: '9012' },
      },
    });
    expect(JSON.stringify(out)).not.toMatch(/SECRET ADDRESS|BASE64|hash/);
  });

  it('reads the back side and a card without a QR', async () => {
    fake = await startFake(() => ({ status: 200, body: okBody('AADHAAR_BACK', { qr_details: undefined }) }));
    const out = await build(fake.url).readAadhaarImage(img);
    expect(out).toMatchObject({ ok: true, result: { side: 'back', qr: null } });
  });

  it('marks INVALID documents as not valid', async () => {
    fake = await startFake(() => ({ status: 200, body: okBody('AADHAAR_FRONT', { status: 'INVALID' }) }));
    expect(await build(fake.url).readAadhaarImage(img)).toMatchObject({ ok: true, result: { valid: false } });
  });

  it('retries once with a new id when Cashfree says the verification_id already exists', async () => {
    fake = await startFake((n) =>
      n === 1
        ? { status: 409, body: { code: 'verification_id_already_exists', message: 'exists' } }
        : { status: 200, body: okBody('AADHAAR_FRONT') },
    );
    const out = await build(fake.url).readAadhaarImage(img);
    expect(out.ok).toBe(true);
    expect(fake.seen).toHaveLength(2);
    expect(fake.seen[0].fields.verification_id).not.toBe(fake.seen[1].fields.verification_id);
  });

  it.each([
    ['file_content_too_large', 400],
    ['file_type_invalid', 400],
    ['file_content_invalid', 400],
  ])('turns %s into a "could not read this file" refusal', async (code, status) => {
    fake = await startFake(() => ({ status, body: { code, message: code } }));
    const out = await build(fake.url).readAadhaarImage(img);
    expect(out).toMatchObject({ ok: false });
    expect((out as any).reason).toMatch(/could not read this file/i);
  });

  it.each([
    [401, 'authentication_failed'],
    [403, 'ip_validation_failed'],
    [422, 'insufficient_balance'],
    [429, 'too_many_requests_per_operation'],
    [500, 'verification_failed'],
    [502, 'verification_failed'],
  ])('answers 503 (so the caller can fall back to an admin) on %s %s', async (status, code) => {
    fake = await startFake(() => ({ status, body: { code, message: 'x' } }));
    await expect(build(fake.url).readAadhaarImage(img)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each([
    [400, 'invalid_request', 'Verification Suite is not enabled for this account'],
    [400, 'x-client-secret_value_invalid', 'Client secret belongs to test environment'],
    [400, 'x-client-id_missing', 'x-client-id is missing in the request'],
  ])('treats a %s %s account problem as 503, not as a rejected document', async (status, code, message) => {
    fake = await startFake(() => ({ status, body: { code, message } }));
    await expect(build(fake.url).readAadhaarImage(img)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('answers 503 when Cashfree cannot be reached at all', async () => {
    await expect(build('http://127.0.0.1:1/verification').readAadhaarImage(img)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('answers 503 without credentials instead of faking a result', async () => {
    const cf = new CashfreeService({ get: () => undefined } as unknown as ConfigService);
    await expect(cf.readAadhaarImage(img)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
