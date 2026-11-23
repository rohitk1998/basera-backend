import { Controller, ForbiddenException, Get, HttpCode, Logger, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { safeEqual, verifyMetaSignature } from './whatsapp-signature.util';
import { WhatsappService } from './whatsapp.service';

@SkipThrottle()
@Controller('api/whatsapp/webhook')
export class WhatsappWebhookController {
  private readonly logger = new Logger(WhatsappWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /** Meta subscription handshake. Returns hub.challenge as plain text. */
  @Get()
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ) {
    const expected = this.config.get<string>('WHATSAPP_VERIFY_TOKEN');
    if (mode !== 'subscribe' || !expected || !token || !safeEqual(token, expected) || challenge === undefined) {
      throw new ForbiddenException();
    }
    return challenge;
  }

  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>) {
    const secret = this.config.get<string>('WHATSAPP_APP_SECRET') ?? '';
    if (!verifyMetaSignature(req.rawBody, req.header('x-hub-signature-256'), secret)) {
      throw new UnauthorizedException('Invalid signature');
    }
    let body: unknown;
    try {
      body = JSON.parse(req.rawBody!.toString('utf8'));
    } catch {
      return { received: true };
    }
    try {
      await this.whatsapp.handleWebhook(body);
    } catch (e) {
      // Always 200 once authenticated so Meta does not retry-storm; the error is logged.
      this.logger.error(`webhook processing failed: ${(e as Error).message}`);
    }
    return { received: true };
  }
}
