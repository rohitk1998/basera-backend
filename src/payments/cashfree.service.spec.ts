import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { CashfreeService } from './cashfree.service';

function build(env: Record<string, string | undefined>) {
  return new CashfreeService({ get: (k: string) => env[k] } as unknown as ConfigService);
}

describe('CashfreeService.verifyWebhookSignature', () => {
  const secret = 'pg-secret';
  const now = 1_700_000_000_000;
  const ts = String(now);
  const body = '{"data":{"order":{"order_id":"bk_1_1"}}}';
  const hmac = (data: string, key = secret) => createHmac('sha256', key).update(data).digest('base64');
  const svc = build({ CASHFREE_PG_CLIENT_SECRET: secret });

  it('accepts timestamp+body (no separator)', () => {
    expect(svc.verifyWebhookSignature(Buffer.from(body), hmac(ts + body), ts, now)).toBe(true);
  });

  it('accepts a string body', () => {
    expect(svc.verifyWebhookSignature(body, hmac(ts + body), ts, now)).toBe(true);
  });

  it('rejects the undocumented timestamp.body (dot) variant', () => {
    expect(svc.verifyWebhookSignature(body, hmac(`${ts}.${body}`), ts, now)).toBe(false);
  });

  it('freshness: accepts within 10 minutes, rejects older or far-future timestamps (replay)', () => {
    const sig = hmac(ts + body);
    expect(svc.verifyWebhookSignature(body, sig, ts, now + 9 * 60_000)).toBe(true);
    expect(svc.verifyWebhookSignature(body, sig, ts, now + 11 * 60_000)).toBe(false);
    expect(svc.verifyWebhookSignature(body, sig, ts, now - 11 * 60_000)).toBe(false);
  });

  it('rejects a non-numeric timestamp even when the signature matches it', () => {
    expect(svc.verifyWebhookSignature(body, hmac('abc' + body), 'abc', now)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(svc.verifyWebhookSignature(Buffer.from(body), hmac(ts + body, 'other'), ts, now)).toBe(false);
  });

  it('rejects when the signature or timestamp header is missing', () => {
    expect(svc.verifyWebhookSignature(Buffer.from(body), undefined, ts, now)).toBe(false);
    expect(svc.verifyWebhookSignature(Buffer.from(body), hmac(ts + body), undefined, now)).toBe(false);
  });

  it('rejects a tampered body, a different timestamp, and a wrong-length signature', () => {
    const sig = hmac(ts + body);
    expect(svc.verifyWebhookSignature(Buffer.from(body.replace('bk_1_1', 'bk_2_1')), sig, ts, now)).toBe(false);
    expect(svc.verifyWebhookSignature(Buffer.from(body), sig, String(now + 1), now)).toBe(false);
    expect(svc.verifyWebhookSignature(Buffer.from(body), 'short', ts, now)).toBe(false);
  });

  it('rejects everything when the PG secret is not configured', () => {
    expect(build({}).verifyWebhookSignature(Buffer.from(body), hmac(ts + body, ''), ts, now)).toBe(false);
  });
});

describe('CashfreeService refunds / terminate (mocked fetch)', () => {
  const svc = build({ CASHFREE_PG_CLIENT_ID: 'id', CASHFREE_PG_CLIENT_SECRET: 's' });
  const reply = (status: number, json: unknown) => jest.spyOn(global, 'fetch').mockResolvedValueOnce({ status, json: async () => json } as Response);
  afterEach(() => jest.restoreAllMocks());

  it('createRefund posts refund_id as idempotency key to /orders/{id}/refunds', async () => {
    const spy = reply(200, { refund_id: 'rf_1', cf_refund_id: 77, refund_status: 'PENDING', refund_amount: 50 });
    const r = await svc.createRefund('o1', 'rf_1', 50, 'note');
    expect(r).toEqual({ refundId: 'rf_1', cfRefundId: '77', status: 'PENDING', amount: 50 });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/orders/o1/refunds');
    expect(JSON.parse(init.body as string)).toMatchObject({ refund_id: 'rf_1', refund_amount: 50 });
  });

  it('createRefund on a duplicate refund_id returns the existing refund', async () => {
    reply(409, { code: 'refund_id_already_exists' });
    reply(200, { refund_id: 'rf_1', cf_refund_id: 77, refund_status: 'SUCCESS', refund_amount: 50 });
    expect((await svc.createRefund('o1', 'rf_1', 50)).status).toBe('SUCCESS');
  });

  it('createRefund surfaces a gateway rejection with its status', async () => {
    reply(400, { code: 'refund_amount_invalid', message: 'bad' });
    await expect(svc.createRefund('o1', 'rf_2', 5)).rejects.toMatchObject({ cashfreeStatus: 400 });
  });

  it('terminateOrder PATCHes TERMINATED; 404 -> null; 400 reports the real status', async () => {
    const spy = reply(200, { order_status: 'TERMINATED' });
    expect(await svc.terminateOrder('o1')).toBe('TERMINATED');
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
    reply(404, {});
    expect(await svc.terminateOrder('o2')).toBeNull();
    reply(400, { code: 'order_terminate_invalid' });
    reply(200, { order_id: 'o3', order_status: 'PAID', order_amount: 1 });
    expect(await svc.terminateOrder('o3')).toBe('PAID');
  });

  it('createPgOrder 409 with a different amount is a ConflictException', async () => {
    reply(409, {});
    reply(200, { order_id: 'o4', order_status: 'ACTIVE', order_amount: 11 });
    await expect(
      svc.createPgOrder({ orderId: 'o4', amount: 99, customerId: 'c', customerPhone: '1', returnUrl: 'x' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
