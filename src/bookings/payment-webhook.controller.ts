import { Controller, HttpCode, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CashfreeService } from '../payments/cashfree.service';
import { PaymentsService } from '../payments/payments.service';
import { BookingsService } from './bookings.service';

@SkipThrottle()
@Controller('api/payments/cashfree')
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);

  constructor(
    private readonly cashfree: CashfreeService,
    private readonly payments: PaymentsService,
    private readonly bookings: BookingsService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async handle(@Req() req: RawBodyRequest<Request>) {
    const raw = req.rawBody;
    const valid =
      raw !== undefined &&
      this.cashfree.verifyWebhookSignature(
        raw,
        req.header('x-webhook-signature'),
        req.header('x-webhook-timestamp'),
      );
    if (!valid) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let orderId: unknown;
    try {
      orderId = JSON.parse(raw.toString('utf8'))?.data?.order?.order_id;
    } catch {
      return { received: true };
    }
    if (typeof orderId !== 'string') return { received: true };

    const payment = await this.payments.getByOrderId(orderId);
    if (!payment) {
      this.logger.warn(`Webhook for unknown order ${orderId}`);
      return { received: true };
    }
    await this.bookings.syncPayment(payment.booking_id);
    return { received: true };
  }
}
