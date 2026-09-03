import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { MocksService } from './mocks.service';
import { VerifyUpiDto } from './dto/verify-upi.dto';
import { SubscribeDto } from './dto/subscribe.dto';
import { VerifyKycDto } from './dto/verify-kyc.dto';

// Originals (app/api/banking/verify-upi, app/api/billing/subscribe,
// app/api/kyc/verify) all called requireAuth() — mocked providers, but
// still gated behind a logged-in user.
@Controller('api')
@UseGuards(AuthGuard)
export class MocksController {
  constructor(private readonly mocksService: MocksService) {}

  @Post('banking/verify-upi')
  verifyUpi(@CurrentUser() user: AuthUser, @Body() dto: VerifyUpiDto) {
    return this.mocksService.verifyUpi(user.userId, dto.upiId);
  }

  @Post('billing/subscribe')
  subscribe(@CurrentUser() user: AuthUser, @Body() dto: SubscribeDto) {
    return this.mocksService.subscribe(user.userId, dto.planId, dto.listingId);
  }

  @Post('kyc/verify')
  verifyKyc(@CurrentUser() user: AuthUser, @Body() dto: VerifyKycDto) {
    return this.mocksService.verifyKyc(user.userId, dto.documentType, dto.documentNumber);
  }
}
