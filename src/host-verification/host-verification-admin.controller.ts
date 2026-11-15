import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { RejectCaseDto } from './host-verification.dto';
import { HostVerificationService } from './host-verification.service';

@Controller('api/admin/host-verification')
@UseGuards(AdminGuard)
export class HostVerificationAdminController {
  constructor(private readonly service: HostVerificationService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.service.listQueue(status);
  }

  @Get(':id/media')
  media(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: AuthUser) {
    return this.service.getMediaUrls(id, admin.userId);
  }

  @ResponseMessage('Host verified. Raw files deleted.')
  @Post(':id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: AuthUser) {
    return this.service.approve(id, admin.userId);
  }

  @ResponseMessage('Verification rejected.')
  @Post(':id/reject')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectCaseDto, @CurrentUser() admin: AuthUser) {
    return this.service.reject(id, admin.userId, dto.reason.trim(), dto.ban === true);
  }
}
