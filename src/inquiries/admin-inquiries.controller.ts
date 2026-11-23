import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { AssignInquiryDto, InquiryActionDto, ListInquiriesQueryDto } from './dto/admin-inquiry.dto';
import { InquiriesService } from './inquiries.service';

@Controller('api/admin/inquiries')
@UseGuards(AdminGuard)
@Throttle({ default: { ttl: 60_000, limit: 120 } })
export class AdminInquiriesController {
  constructor(private readonly service: InquiriesService) {}

  @Get()
  list(@Query() q: ListInquiriesQueryDto) {
    return this.service.list(q);
  }

  @Get('analytics')
  analytics(@Query('days') days?: string) {
    return this.service.analytics(Number.parseInt(days ?? '30', 10));
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }

  @Post(':id/assign')
  @ResponseMessage('Assignment updated.')
  assign(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Body() dto: AssignInquiryDto) {
    return this.service.assign(id, dto.assigneeId, u.userId);
  }

  @Post(':id/contacting')
  @ResponseMessage('Marked as contacting the owner.')
  contacting(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Body() dto: InquiryActionDto) {
    return this.service.contacting(id, u.userId, dto.note);
  }

  @Post(':id/send-to-owner')
  @ResponseMessage('Request sent to the owner.')
  sendToOwner(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Body() dto: InquiryActionDto) {
    return this.service.sendToOwner(id, u.userId, dto.note);
  }

  @Post(':id/not-available')
  @ResponseMessage('Guest told the dates are not available.')
  notAvailable(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Body() dto: InquiryActionDto) {
    return this.service.notAvailable(id, u.userId, dto.note);
  }
}
