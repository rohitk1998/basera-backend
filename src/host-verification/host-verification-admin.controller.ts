import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { ApproveCaseDto, QueueQueryDto, RejectCaseDto, RevokeDto } from './host-verification.dto';
import { HostVerificationService } from './host-verification.service';

@Controller('api/admin/host-verification')
@UseGuards(AdminGuard)
export class HostVerificationAdminController {
  constructor(private readonly service: HostVerificationService) {}

  @Get()
  list(@Query() query: QueueQueryDto) {
    return this.service.listQueue(query);
  }

  @Get(':id/media')
  media(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: AuthUser) {
    return this.service.getMediaUrls(id, admin.userId);
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ResponseMessage('Host verified. Raw files deleted.')
  @Post(':id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApproveCaseDto, @CurrentUser() admin: AuthUser) {
    return this.service.approve(id, admin.userId, dto);
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ResponseMessage('Verification rejected.')
  @Post(':id/reject')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectCaseDto, @CurrentUser() admin: AuthUser) {
    return this.service.reject(id, admin.userId, dto.reason.trim(), dto.ban === true);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ResponseMessage('Face match re-scored.')
  @Post(':id/rescore')
  rescore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: AuthUser) {
    return this.service.rescore(id, admin.userId);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ResponseMessage('Verification revoked.')
  @Post('users/:userId/revoke')
  revoke(@Param('userId', ParseUUIDPipe) userId: string, @Body() dto: RevokeDto, @CurrentUser() admin: AuthUser) {
    return this.service.revoke(userId, admin.userId, dto.reason.trim(), dto.ban === true);
  }
}
