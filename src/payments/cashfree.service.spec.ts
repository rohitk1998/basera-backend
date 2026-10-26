import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { CashfreeService } from './cashfree.service';

function build(env: Record<string, string | undefined>) {
  return new CashfreeService({ get: (k: string) => env[k] } as unknown as ConfigService);
}

describe('CashfreeService.verifyWebhookSignature', () => {
  const secret = 'pg-secret';
  const ts = '1700000000000';
  const body = '{"data":{"order":{"order_id":"bk_1_1"}}}';
  const hmac = (data: string, key = secret) => createHmac('sha256', key).update(data).digest('base64');
  const svc = build({ CASHFREE_PG_CLIENT_SECRET: secret });

  it('accepts timestamp+body (no separator)', () => {
    expect(svc.verifyWebhookSignature(Buffer.from(body), hmac(ts + body), ts)).toBe(true);
  });

  it('accepts timestamp.body (dot separator) and a string body', () => {
    expect(svc.verifyWebhookSignature(body, hmac(`${ts}.${body}`), ts)).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(svc.verifyWebhookSignature(Buffer.from(body), hmac(ts + body, 'other'), ts)).toBe(false);
  });

  it('rejects when the signature or timestamp header is missing', () => {
    expect(svc.verifyWebhookSignature(Buffer.from(body), undefined, ts)).toBe(false);
    expect(svc.verifyWebhookSignature(Buffer.from(body), hmac(ts + body), undefined)).toBe(false);
  });

  it('rejects a tampered body, a different timestamp, and a wrong-length signature', () => {
    const sig = hmac(ts + body);
    expect(svc.verifyWebhookSignature(Buffer.from(body.replace('bk_1_1', 'bk_2_1')), sig, ts)).toBe(false);
    expect(svc.verifyWebhookSignature(Buffer.from(body), sig, '1700000000001')).toBe(false);
    expect(svc.verifyWebhookSignature(Buffer.from(body), 'short', ts)).toBe(false);
  });

  it('rejects everything when the PG secret is not configured', () => {
    expect(build({}).verifyWebhookSignature(Buffer.from(body), hmac(ts + body, ''), ts)).toBe(false);
  });
});
