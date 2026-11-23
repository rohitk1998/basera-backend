import { Controller, HttpCode, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CashfreeService } from '../payments/cashfree.service';
import { PaymentsService } from '../payments/payments.service';
import { RefundService } from '../finance/refund.service';
import { BookingsService } from './bookings.service';

/**
 * Cashfree webhook receiver. Authenticated by HMAC over `timestamp + rawBody` and a 10 minute
 * freshness window (see CashfreeService.verifyWebhookSignature). Every handler is idempotent so
 * duplicate deliveries and replays inside the window are harmless.
 */
@SkipThrottle()
@Controller('api/payments/cashfree')
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);

  constructor(
    private readonly cashfree: CashfreeService,
    private readonly payments: PaymentsService,
    private readonly bookings: BookingsService,
    private readonly refunds: RefundService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async handle(@Req() req: RawBodyRequest<Request>) {
    const raw = req.rawBody;
    const valid =
      raw !== undefined &&
      this.cashfree.verifyWebhookSignature(raw, req.header('x-webhook-signature'), req.header('x-webhook-timestamp'));
    if (!valid) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let event: any;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return { received: true };
    }
    const type: string | undefined = event?.type;

    if (type === 'REFUND_STATUS_WEBHOOK') {
      await this.refunds.handleWebhook(event?.data?.refund);
      return { received: true };
    }

    const orderId = event?.data?.order?.order_id;
    if (typeof orderId !== 'string') return { received: true };
    const payment = await this.payments.getByOrderId(orderId);
    if (!payment) {
      this.logger.warn(`Webhook ${type ?? '?'} for unknown order ${orderId}`);
      return { received: true };
    }

    switch (type) {
      case 'PAYMENT_FAILED_WEBHOOK':
      case 'PAYMENT_USER_DROPPED_WEBHOOK':
        // The order stays ACTIVE at Cashfree and the guest may retry on it, so the payment is NOT
        // failed here (expiry/termination is picked up by syncPayment). Acknowledge and log only.
        this.logger.log(`Webhook ${type} for order ${orderId} (booking ${payment.booking_id}): attempt did not complete`);
        return { received: true };
      case 'PAYMENT_SUCCESS_WEBHOOK':
      default:
        // Success and any unrecognised order event: the authoritative state is re-fetched from Cashfree.
        await this.bookings.syncPayment(payment.booking_id);
        return { received: true };
    }
  }
}
