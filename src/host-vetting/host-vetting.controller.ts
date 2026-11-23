import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { DEFAULT_AUDIT_STALE_DAYS, DEFAULT_DUE_LIMIT, MAX_DUE_LIMIT } from './host-vetting.constants';
import { AddAuditDto, SetRatingDto } from './host-vetting.dto';
import { HostVettingService } from './host-vetting.service';

@Controller('api/admin/vetting')
@UseGuards(AdminGuard)
export class HostVettingController {
  constructor(private readonly service: HostVettingService) {}

  // Declared before ':listingId' routes so 'audits-due' is never read as an id.
  @Get('audits-due')
  due(@Query('days') days?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    const parsed = Number.parseInt(days ?? '', 10);
    const clamped = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 3650) : DEFAULT_AUDIT_STALE_DAYS;
    const parsedLimit = Number.parseInt(limit ?? '', 10);
    const parsedOffset = Number.parseInt(offset ?? '', 10);
    const boundedLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), MAX_DUE_LIMIT) : DEFAULT_DUE_LIMIT;
    const boundedOffset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;
    return this.service.listDue(clamped, boundedLimit, boundedOffset);
  }

  @Get(':listingId')
  get(@Param('listingId', ParseUUIDPipe) listingId: string) {
    return this.service.getVetting(listingId);
  }

  @ResponseMessage('External rating saved.')
  @Put(':listingId/rating')
  setRating(
    @Param('listingId', ParseUUIDPipe) listingId: string,
    @CurrentUser() admin: AuthUser,
    @Body() dto: SetRatingDto,
  ) {
    return this.service.setRating(listingId, admin.userId, dto);
  }

  @ResponseMessage('Audit note added.')
  @Post(':listingId/audits')
  addAudit(
    @Param('listingId', ParseUUIDPipe) listingId: string,
    @CurrentUser() admin: AuthUser,
    @Body() dto: AddAuditDto,
  ) {
    return this.service.addAudit(listingId, admin.userId, dto);
  }
}
