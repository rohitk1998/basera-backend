import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface PgOrder {
  orderId: string;
  status: string;
  amount: number;
  currency: string;
  paymentSessionId: string | null;
}

export interface PgRefund {
  refundId: string;
  cfRefundId: string | null;
  status: string;
  amount: number;
}

const PG_TIMEOUT_MS = 15_000;
/** Webhooks whose x-webhook-timestamp is older (or further in the future) than this are rejected as replays. */
export const WEBHOOK_MAX_AGE_MS = 10 * 60 * 1000;

@Injectable()
export class CashfreeService {
  private readonly logger = new Logger(CashfreeService.name);
  private readonly environment: string;
  private readonly pgClientId: string | undefined;
  private readonly pgClientSecret: string | undefined;
  private readonly pgApiVersion: string;

  constructor(private readonly config: ConfigService) {
    this.environment = this.config.get<string>('CASHFREE_ENVIRONMENT') ?? 'sandbox';
    this.pgClientId = this.config.get<string>('CASHFREE_PG_CLIENT_ID');
    this.pgClientSecret = this.config.get<string>('CASHFREE_PG_CLIENT_SECRET');
    this.pgApiVersion = this.config.get<string>('CASHFREE_PG_API_VERSION') ?? '2023-08-01';
  }

  private getPgBaseUrl(): string {
    return this.environment === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
  }

  get checkoutMode(): 'sandbox' | 'production' {
    return this.environment === 'production' ? 'production' : 'sandbox';
  }

  private pgHeaders(): Record<string, string> {
    if (!this.pgClientId || !this.pgClientSecret) {
      throw new ServiceUnavailableException('Payments are not available right now. Please try again later.');
    }
    return {
      'Content-Type': 'application/json',
      'x-api-version': this.pgApiVersion,
      'x-client-id': this.pgClientId,
      'x-client-secret': this.pgClientSecret,
    };
  }

  private toPgOrder(d: any): PgOrder {
    return {
      orderId: String(d.order_id),
      status: String(d.order_status),
      amount: Number(d.order_amount),
      currency: String(d.order_currency ?? 'INR'),
      paymentSessionId: d.payment_session_id ?? null,
    };
  }

  private async pgRequest(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const attempt = async () => {
      const res = await fetch(`${this.getPgBaseUrl()}${path}`, {
        method,
        headers: this.pgHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(PG_TIMEOUT_MS),
      });
      const data: any = await res.json().catch(() => ({}));
      return { status: res.status, data };
    };
    try {
      let result = await attempt();
      if (method === 'GET' && result.status >= 500) result = await attempt();
      if (result.status >= 500) throw new Error(`Cashfree ${path} -> ${result.status}`);
      return result;
    } catch (e) {
      if (e instanceof ServiceUnavailableException) throw e;
      this.logger.error(`[Cashfree] ${method} ${path} failed`, e as Error);
      throw new ServiceUnavailableException('Could not reach the payment service. Please try again.');
    }
  }

  async createPgOrder(params: {
    orderId: string;
    amount: number;
    customerId: string;
    customerPhone: string;
    customerEmail?: string;
    customerName?: string;
    returnUrl: string;
    notifyUrl?: string;
  }): Promise<PgOrder> {
    const { status, data } = await this.pgRequest('POST', '/orders', {
      order_id: params.orderId,
      order_amount: params.amount,
      order_currency: 'INR',
      customer_details: {
        customer_id: params.customerId,
        customer_phone: params.customerPhone,
        ...(params.customerEmail ? { customer_email: params.customerEmail } : {}),
        ...(params.customerName ? { customer_name: params.customerName } : {}),
      },
      order_meta: {
        return_url: params.returnUrl,
        ...(params.notifyUrl ? { notify_url: params.notifyUrl } : {}),
      },
    });
    if (status === 200 || status === 201) return this.toPgOrder(data);
    if (status === 409) {
      const existing = await this.fetchPgOrder(params.orderId);
      if (existing) {
        // A reused order id with a different amount must never be treated as "the same order".
        if (existing.amount !== params.amount) {
          throw new ConflictException('A payment order with a different amount already exists for this booking.');
        }
        return existing;
      }
    }
    this.logger.error(`[Cashfree] create order -> ${status} ${data?.code ?? ''} ${data?.message ?? ''}`);
    throw new ServiceUnavailableException('Could not start the payment. Please try again.');
  }

  async fetchPgOrder(orderId: string): Promise<PgOrder | null> {
    const { status, data } = await this.pgRequest('GET', `/orders/${encodeURIComponent(orderId)}`);
    if (status === 404) return null;
    if (status !== 200) {
      this.logger.error(`[Cashfree] fetch order -> ${status} ${data?.code ?? ''} ${data?.message ?? ''}`);
      throw new ServiceUnavailableException('Could not check the payment. Please try again.');
    }
    return this.toPgOrder(data);
  }

  async fetchSuccessfulPaymentId(orderId: string): Promise<string | null> {
    try {
      const { status, data } = await this.pgRequest('GET', `/orders/${encodeURIComponent(orderId)}/payments`);
      if (status !== 200 || !Array.isArray(data)) return null;
      const ok = data.find((p: any) => p?.payment_status === 'SUCCESS');
      return ok?.cf_payment_id != null ? String(ok.cf_payment_id) : null;
    } catch {
      return null;
    }
  }

  /**
   * Close an order so it can no longer be paid (cancel / expiry). Idempotent: an order that is
   * already terminal (PAID, EXPIRED, TERMINATED) or unknown is reported, not thrown.
   * Returns the order status after the call, or null when Cashfree does not know the order.
   */
  async terminateOrder(orderId: string): Promise<string | null> {
    const { status, data } = await this.pgRequest('PATCH', `/orders/${encodeURIComponent(orderId)}`, {
      order_status: 'TERMINATED',
    });
    if (status === 200) return String(data?.order_status ?? 'TERMINATED');
    if (status === 404) return null;
    // 400 = order already PAID/EXPIRED/TERMINATED (cannot be terminated); report real state.
    const current = await this.fetchPgOrder(orderId).catch(() => null);
    if (current) return current.status;
    this.logger.error(`[Cashfree] terminate order -> ${status} ${data?.code ?? ''} ${data?.message ?? ''}`);
    throw new ServiceUnavailableException('Could not close the payment order.');
  }

  private toPgRefund(d: any): PgRefund {
    return {
      refundId: String(d.refund_id),
      cfRefundId: d.cf_refund_id != null ? String(d.cf_refund_id) : null,
      status: String(d.refund_status ?? 'PENDING'),
      amount: Number(d.refund_amount),
    };
  }

  /** POST /orders/{order_id}/refunds. refund_id is the idempotency key: a replay returns the existing refund. */
  async createRefund(orderId: string, refundId: string, amount: number, note?: string): Promise<PgRefund> {
    const { status, data } = await this.pgRequest('POST', `/orders/${encodeURIComponent(orderId)}/refunds`, {
      refund_amount: amount,
      refund_id: refundId,
      refund_note: (note ?? 'Refund').slice(0, 100),
      refund_speed: 'STANDARD',
    });
    if (status === 200 || status === 201) return this.toPgRefund(data);
    if (status === 409 || data?.code === 'refund_id_already_exists') {
      const existing = await this.getRefund(orderId, refundId);
      if (existing) return existing;
    }
    this.logger.error(`[Cashfree] create refund -> ${status} ${data?.code ?? ''} ${data?.message ?? ''}`);
    const err: any = new ServiceUnavailableException(data?.message ?? 'Refund could not be created.');
    err.cashfreeCode = data?.code;
    err.cashfreeStatus = status;
    throw err;
  }

  async getRefund(orderId: string, refundId: string): Promise<PgRefund | null> {
    const { status, data } = await this.pgRequest(
      'GET',
      `/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`,
    );
    if (status === 404) return null;
    if (status !== 200) throw new ServiceUnavailableException('Could not check the refund.');
    return this.toPgRefund(data);
  }

  /**
   * Cashfree's documented scheme: base64(HMAC-SHA256(secret, timestamp + rawBody)), compared in
   * constant time. `now` is injectable for tests. Timestamp must be epoch ms (or seconds) within
   * WEBHOOK_MAX_AGE_MS of now, in either direction.
   */
  verifyWebhookSignature(
    rawBody: Buffer | string,
    signature: string | undefined,
    timestamp: string | undefined,
    now: number = Date.now(),
  ): boolean {
    if (!this.pgClientSecret || !signature || !timestamp) return false;
    if (!this.isFreshTimestamp(timestamp, now)) return false;
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = Buffer.from(createHmac('sha256', this.pgClientSecret).update(`${timestamp}${body}`).digest('base64'));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  isFreshTimestamp(timestamp: string, now: number = Date.now()): boolean {
    if (!/^\d{9,16}$/.test(timestamp)) return false;
    let ms = Number(timestamp);
    if (ms < 1e11) ms *= 1000; // seconds -> ms
    return Math.abs(now - ms) <= WEBHOOK_MAX_AGE_MS;
  }
}
