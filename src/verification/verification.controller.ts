import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { VerificationService } from './verification.service';

@Controller('api/verification')
@UseGuards(AuthGuard)
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get('status')
  async getStatus(@CurrentUser() user: AuthUser) {
    const status = await this.verification.getMyStatus(user.userId);
    return { success: true, ...status };
  }

  @Get(':id/document-url')
  async getDocumentUrl(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const result = await this.verification.getMyDocumentUrl(user.userId, id);
    return { success: true, ...result };
  }
}
