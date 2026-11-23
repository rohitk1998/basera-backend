import { createHmac } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { CashfreeService } from '../payments/cashfree.service';
import { PaymentWebhookController } from './payment-webhook.controller';

const SECRET = 's3cret';

function setup() {
  const cashfree = new CashfreeService({ get: (k: string) => ({ CASHFREE_PG_CLIENT_SECRET: SECRET } as any)[k] } as any);
  const payments: any = { getByOrderId: jest.fn().mockResolvedValue({ booking_id: 'b1' }) };
  const bookings: any = { syncPayment: jest.fn() };
  const refunds: any = { handleWebhook: jest.fn() };
  const ctl = new PaymentWebhookController(cashfree, payments, bookings, refunds);
  const req = (event: unknown, ts = String(Date.now()), secret = SECRET) => {
    const raw = Buffer.from(JSON.stringify(event));
    const sig = createHmac('sha256', secret).update(ts + raw.toString()).digest('base64');
    return { rawBody: raw, header: (h: string) => ({ 'x-webhook-signature': sig, 'x-webhook-timestamp': ts } as any)[h] } as any;
  };
  return { ctl, req, bookings, refunds, payments };
}
const order = (type: string) => ({ type, data: { order: { order_id: 'bk_1' } } });

describe('PaymentWebhookController', () => {
  it('rejects a stale (replayed) but correctly signed webhook', async () => {
    const t = setup();
    const old = String(Date.now() - 11 * 60_000);
    await expect(t.ctl.handle(t.req(order('PAYMENT_SUCCESS_WEBHOOK'), old))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(t.bookings.syncPayment).not.toHaveBeenCalled();
  });

  it('rejects a wrong-secret signature', async () => {
    const t = setup();
    await expect(t.ctl.handle(t.req(order('PAYMENT_SUCCESS_WEBHOOK'), undefined, 'other'))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('PAYMENT_SUCCESS_WEBHOOK syncs the payment', async () => {
    const t = setup();
    await t.ctl.handle(t.req(order('PAYMENT_SUCCESS_WEBHOOK')));
    expect(t.bookings.syncPayment).toHaveBeenCalledWith('b1');
  });

  it('PAYMENT_FAILED / USER_DROPPED are acknowledged without changing payment state', async () => {
    const t = setup();
    for (const type of ['PAYMENT_FAILED_WEBHOOK', 'PAYMENT_USER_DROPPED_WEBHOOK']) {
      await expect(t.ctl.handle(t.req(order(type)))).resolves.toEqual({ received: true });
    }
    expect(t.bookings.syncPayment).not.toHaveBeenCalled();
  });

  it('REFUND_STATUS_WEBHOOK is routed to the refund service', async () => {
    const t = setup();
    const refund = { refund_id: 'rf_x', refund_status: 'SUCCESS' };
    await t.ctl.handle(t.req({ type: 'REFUND_STATUS_WEBHOOK', data: { refund } }));
    expect(t.refunds.handleWebhook).toHaveBeenCalledWith(refund);
    expect(t.bookings.syncPayment).not.toHaveBeenCalled();
  });

  it('unknown order is acknowledged', async () => {
    const t = setup();
    t.payments.getByOrderId.mockResolvedValue(null);
    await expect(t.ctl.handle(t.req(order('PAYMENT_SUCCESS_WEBHOOK')))).resolves.toEqual({ received: true });
  });
});
