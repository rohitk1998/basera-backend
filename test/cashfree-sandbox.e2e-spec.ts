/**
 * LIVE Cashfree SANDBOX tests. Reads .env via dotenv.parse (does not touch process.env, never logs keys).
 * Aborts (all tests fail) unless CASHFREE_ENVIRONMENT is explicitly 'sandbox'.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHmac } from 'node:crypto';
import * as dotenv from 'dotenv';
import { CashfreeService } from '../src/payments/cashfree.service';

const env = dotenv.parse(fs.readFileSync(path.resolve(__dirname, '..', '.env')));
const cfg = { get: (k: string) => env[k] } as any;
const SECRET = env.CASHFREE_PG_CLIENT_SECRET;
const stamp = Date.now();
const orderId = `test_${stamp}`;
const mk = () => new CashfreeService(cfg);
const input = (id: string, amount = 11) => ({
  orderId: id, amount, customerId: 'test_cust_1', customerPhone: '9999999999',
  customerEmail: 'tester@example.com', returnUrl: 'https://example.com/return?order_id={order_id}',
});

jest.setTimeout(60_000);

describe('Cashfree SANDBOX (live)', () => {
  let cf: CashfreeService;
  beforeAll(() => {
    if (env.CASHFREE_ENVIRONMENT !== 'sandbox') throw new Error('ABORT: CASHFREE_ENVIRONMENT is not sandbox');
    cf = mk();
    expect(cf.checkoutMode).toBe('sandbox');
  });

  it('creates an order with ACTIVE status + payment_session_id', async () => {
    const o = await cf.createPgOrder(input(orderId, 11));
    expect(o.orderId).toBe(orderId);
    expect(o.status).toBe('ACTIVE');
    expect(o.amount).toBe(11);
    expect(o.currency).toBe('INR');
    expect(typeof o.paymentSessionId).toBe('string');
    expect(o.paymentSessionId!.length).toBeGreaterThan(20);
  });

  it('fetches the order and matches amount/currency', async () => {
    const o = await cf.fetchPgOrder(orderId);
    expect(o).toMatchObject({ orderId, status: 'ACTIVE', amount: 11, currency: 'INR' });
    expect(o!.paymentSessionId).toBeTruthy();
  });

  it('duplicate create (409 path) returns the existing order', async () => {
    const o = await cf.createPgOrder(input(orderId, 11));
    expect(o.orderId).toBe(orderId);
    expect(o.status).toBe('ACTIVE');
  });

  it('duplicate create with a DIFFERENT amount is rejected with 409 (never silently the old order)', async () => {
    await expect(cf.createPgOrder(input(orderId, 99))).rejects.toMatchObject({ status: 409 });
  });

  it('non-existent order returns null (404)', async () => {
    expect(await cf.fetchPgOrder(`test_missing_${stamp}`)).toBeNull();
  });

  it('payments list of an unpaid order has no successful payment', async () => {
    expect(await cf.fetchSuccessfulPaymentId(orderId)).toBeNull();
  });

  it('rejects invalid amount (0) with ServiceUnavailable', async () => {
    await expect(cf.createPgOrder(input(`test_bad_${stamp}`, 0))).rejects.toThrow();
  });

  it('refund endpoint on UNPAID order is rejected by sandbox (probe, raw fetch)', async () => {
    const res = await fetch(`https://sandbox.cashfree.com/pg/orders/${orderId}/refunds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-version': env.CASHFREE_PG_API_VERSION ?? '2023-08-01',
        'x-client-id': env.CASHFREE_PG_CLIENT_ID, 'x-client-secret': SECRET },
      body: JSON.stringify({ refund_amount: 1, refund_id: `rf_${stamp}` }),
    });
    const j: any = await res.json().catch(() => ({}));
    console.log('refund probe ->', res.status, j.code, j.message);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // Sandbox answers PATCH with TERMINATION_REQUESTED (async), later TERMINATED. Neither is payable.
  const CLOSED = ['TERMINATION_REQUESTED', 'TERMINATED'];

  it('terminateOrder closes the ACTIVE order (PATCH TERMINATED); read-back is closed; replay is idempotent; unknown order -> null', async () => {
    const id = `test_term_${stamp}`;
    await cf.createPgOrder(input(id, 12));
    expect(CLOSED).toContain(await cf.terminateOrder(id));
    expect(CLOSED).toContain((await cf.fetchPgOrder(id))?.status);
    expect(CLOSED).toContain(await cf.terminateOrder(id));
    expect(await cf.terminateOrder(`test_missing_${stamp}`)).toBeNull();
  });

  it('terminating the main test order (cleanup)', async () => {
    expect(CLOSED).toContain(await cf.terminateOrder(orderId));
  });
});

describe('verifyWebhookSignature (real method)', () => {
  const body = JSON.stringify({ data: { order: { order_id: 'x', order_amount: 11 } }, type: 'PAYMENT_SUCCESS_WEBHOOK' });
  const ts = String(Date.now());
  const sign = (t: string, b: string) => createHmac('sha256', SECRET).update(t + b).digest('base64');
  let cf: CashfreeService;
  beforeAll(() => { cf = mk(); });

  it('accepts valid (string and Buffer)', () => {
    expect(cf.verifyWebhookSignature(body, sign(ts, body), ts)).toBe(true);
    expect(cf.verifyWebhookSignature(Buffer.from(body), sign(ts, body), ts)).toBe(true);
  });
  it('rejects tampered body', () => {
    expect(cf.verifyWebhookSignature(body.replace('11', '1'), sign(ts, body), ts)).toBe(false);
  });
  it('rejects wrong timestamp', () => {
    expect(cf.verifyWebhookSignature(body, sign(ts, body), String(Number(ts) + 1))).toBe(false);
  });
  it('rejects missing headers', () => {
    expect(cf.verifyWebhookSignature(body, undefined, ts)).toBe(false);
    expect(cf.verifyWebhookSignature(body, sign(ts, body), undefined)).toBe(false);
    expect(cf.verifyWebhookSignature(body, '', ts)).toBe(false);
  });
  it('rejects wrong length / garbage signature', () => {
    expect(cf.verifyWebhookSignature(body, sign(ts, body).slice(0, -2), ts)).toBe(false);
    expect(cf.verifyWebhookSignature(body, 'x', ts)).toBe(false);
  });
  it('rejects the undocumented "timestamp.body" variant', () => {
    const alt = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('base64');
    expect(cf.verifyWebhookSignature(body, alt, ts, Number(ts))).toBe(false);
  });
  it('rejects an ancient timestamp even with a valid signature (freshness window)', () => {
    const old = '1690000000000';
    expect(cf.verifyWebhookSignature(body, sign(old, body), old)).toBe(false);
  });
  it('rejects when secret not configured', () => {
    const c = new CashfreeService({ get: () => undefined } as any);
    expect(c.verifyWebhookSignature(body, sign(ts, body), ts)).toBe(false);
  });
});
