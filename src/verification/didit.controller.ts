import { BadRequestException, Body, Controller, Headers, HttpCode, Post, ServiceUnavailableException, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { DiditService } from './didit.service';
import { VerificationService } from './verification.service';

@Controller('api/verification/didit')
export class DiditController {
  constructor(
    private readonly didit: DiditService,
    private readonly verification: VerificationService,
  ) {}

  @Post('session')
  @UseGuards(AuthGuard)
  async createSession(@CurrentUser() user: AuthUser) {
    await this.verification.assertCanStartDiditSession(user.userId);
    const { sessionId, url } = await this.didit.createSession(user.userId);
    return { success: true, sessionId, url };
  }

  @Post('webhook')
  @HttpCode(200)
  async webhook(@Body() body: unknown, @Headers('x-signature-v2') signature?: string) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid payload.');
    const check = this.didit.verifyWebhook(body, signature);
    if (check === 'not_configured') throw new ServiceUnavailableException('Webhook is not configured.');
    if (check !== 'ok') throw new UnauthorizedException('Invalid signature.');
    const payload = body as Record<string, unknown>;
    if (typeof payload.session_id !== 'string' || !payload.session_id || typeof payload.status !== 'string' || !payload.status) {
      throw new BadRequestException('Invalid payload.');
    }
    await this.verification.applyDiditWebhook(payload);
    return { success: true };
  }
}
