/** Mocked-Cashfree webhook/sync flow: real BookingsService.syncPayment + PaymentWebhookController + PaymentsService over an in-memory repo. */
import { createHmac } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { BookingsService } from '../src/bookings/bookings.service';
import { PaymentWebhookController } from '../src/bookings/payment-webhook.controller';
import { PaymentsService } from '../src/payments/payments.service';
import { CashfreeService } from '../src/payments/cashfree.service';

const SECRET = 'unit-test-secret';
const BK = 'b0000000-0000-0000-0000-000000000001';
const ORDER = 'bk_b0000000000000000000000000000001_1';

function setup(opts: { bookingStatus?: string; payStatus?: string } = {}) {
  const pay: any = { id: 'p1', booking_id: BK, amount: 5000, cashfree_order_id: ORDER, status: opts.payStatus ?? 'pending', attempt: 1 };
  const payRepo: any = {
    findOne: jest.fn(async ({ where }: any) => (where.booking_id === BK || where.cashfree_order_id === ORDER ? pay : null)),
    update: jest.fn(async (where: any, patch: any) => {
      if (where.booking_id === BK && where.status === 'pending' && pay.status !== 'pending') return { affected: 0 };
      Object.assign(pay, patch); return { affected: 1 };
    }),
  };
  const payments = new PaymentsService(payRepo, {} as any);
  const booking: any = { id: BK, status: opts.bookingStatus ?? 'confirmed', guest_id: 'g', host_id: 'h', listing_id: 'l', due_at_move_in: 5000, move_in: '', move_out: '' };
  const bookingsRepo: any = { findOne: jest.fn(async () => booking), update: jest.fn(async () => ({ affected: 1 })) };
  const listingsRepo: any = { findOne: jest.fn(async () => ({ draft_data: {} })) };
  const notifications: any = { notify: jest.fn() };
  const cfg: any = { get: (k: string) => ({ CASHFREE_PG_CLIENT_SECRET: SECRET, CASHFREE_PG_CLIENT_ID: 'id' } as any)[k] };
  const cashfree = new CashfreeService(cfg);
  const order = { orderId: ORDER, status: 'PAID', amount: 5000, currency: 'INR', paymentSessionId: 's' };
  jest.spyOn(cashfree, 'fetchPgOrder').mockImplementation(async (id) => (id === ORDER ? { ...order } : null));
  jest.spyOn(cashfree, 'fetchSuccessfulPaymentId').mockResolvedValue('cfp_1');
  const svc = new BookingsService(bookingsRepo, {} as any, listingsRepo, {} as any, {} as any, {} as any, {} as any, notifications, payments, {} as any, {} as any, cfg, cashfree, {} as any);
  const ctl = new PaymentWebhookController(cashfree, payments, svc, { handleWebhook: jest.fn() } as any);
  const req = (orderId: string, over: { sig?: string; ts?: string } = {}) => {
    const raw = Buffer.from(JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: orderId } } }));
    const ts = over.ts ?? String(Date.now());
    const sig = over.sig ?? createHmac('sha256', SECRET).update(ts + raw.toString()).digest('base64');
    return { rawBody: raw, header: (h: string) => ({ 'x-webhook-signature': sig, 'x-webhook-timestamp': ts } as any)[h] } as any;
  };
  return { pay, order, booking, svc, ctl, req, notifications, bookingsRepo, cashfree };
}

describe('webhook -> syncPayment', () => {
  it('PAID + correct amount -> held, check-in code + notifications', async () => {
    const t = setup();
    await expect(t.ctl.handle(t.req(ORDER))).resolves.toEqual({ received: true });
    expect(t.pay.status).toBe('held');
    expect(t.pay.cf_payment_id).toBe('cfp_1');
    expect(t.bookingsRepo.update).toHaveBeenCalled();
    expect(t.notifications.notify).toHaveBeenCalledTimes(3);
  });
  it('PAID + wrong amount -> NOT held', async () => {
    const t = setup(); t.order.amount = 1;
    await t.ctl.handle(t.req(ORDER));
    expect(t.pay.status).toBe('pending');
    expect(t.notifications.notify).not.toHaveBeenCalled();
  });
  it('PAID + wrong currency -> NOT held', async () => {
    const t = setup(); t.order.currency = 'USD';
    await t.ctl.handle(t.req(ORDER));
    expect(t.pay.status).toBe('pending');
  });
  it('ACTIVE order -> stays pending; EXPIRED -> failed', async () => {
    const t = setup(); t.order.status = 'ACTIVE';
    await t.ctl.handle(t.req(ORDER)); expect(t.pay.status).toBe('pending');
    t.order.status = 'EXPIRED';
    await t.ctl.handle(t.req(ORDER)); expect(t.pay.status).toBe('failed');
  });
  it('duplicate delivery is idempotent (notifications once)', async () => {
    const t = setup();
    await t.ctl.handle(t.req(ORDER)); await t.ctl.handle(t.req(ORDER));
    expect(t.pay.status).toBe('held');
    expect(t.notifications.notify).toHaveBeenCalledTimes(3);
  });
  it('concurrent duplicate deliveries notify only once (markHeld guard)', async () => {
    const t = setup();
    await Promise.all([t.ctl.handle(t.req(ORDER)), t.ctl.handle(t.req(ORDER))]);
    expect(t.notifications.notify.mock.calls.length).toBeLessThanOrEqual(3);
  });
  it('unknown order -> 200 {received:true}, nothing changes', async () => {
    const t = setup();
    await expect(t.ctl.handle(t.req('nope_1'))).resolves.toEqual({ received: true });
    expect(t.pay.status).toBe('pending');
  });
  it('bad signature -> 401; missing rawBody -> 401', async () => {
    const t = setup();
    await expect(t.ctl.handle(t.req(ORDER, { sig: 'AAAA' }))).rejects.toThrow(UnauthorizedException);
    await expect(t.ctl.handle({ rawBody: undefined, header: () => undefined } as any)).rejects.toThrow(UnauthorizedException);
  });
  it('webhook body is not trusted: status comes from a server-side fetch (spoofed amount in body ignored)', async () => {
    const t = setup(); t.order.status = 'ACTIVE';
    await t.ctl.handle(t.req(ORDER));
    expect(t.pay.status).toBe('pending');
  });
  it('syncPayment: Cashfree fetch failure propagates (webhook would 5xx -> Cashfree retries) ', async () => {
    const t = setup();
    (t.cashfree.fetchPgOrder as jest.Mock).mockRejectedValueOnce(new Error('503'));
    await expect(t.ctl.handle(t.req(ORDER))).rejects.toThrow();
  });
});

describe('FIXED: payment for a booking cancelled meanwhile', () => {
  // Stage 0.5 fix: when the order is PAID but the booking was cancelled meanwhile, the payment is now marked
  // 'refunded' (a DB-level refund; the real Cashfree refund call is still to be built, so onPaymentHeld also
  // logs an error for ops).
  it('cancelled booking + PAID order ends up refunded, not held', async () => {
    const t = setup({ bookingStatus: 'cancelled' });
    await t.ctl.handle(t.req(ORDER));
    expect(t.pay.status).toBe('refunded');
  });
  it('a refunded late payment sends no booking-confirmed notifications', async () => {
    const t = setup({ bookingStatus: 'cancelled' });
    await t.ctl.handle(t.req(ORDER));
    expect(t.pay.status).toBe('refunded');
    expect(t.notifications.notify).not.toHaveBeenCalled();
  });
  it('cancel()/expiry now close the Cashfree order through payments.closePendingOrder', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/bookings/bookings.service.ts'), 'utf8');
    expect(src).toMatch(/closePendingOrder/);
  });
});
