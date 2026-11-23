import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { AdminCancelBookingDto, ListAdminBookingsDto } from './admin-bookings.dto';
import { AdminBookingsService } from './admin-bookings.service';

const READ = { default: { ttl: 60_000, limit: 120 } };
const WRITE = { default: { ttl: 60_000, limit: 20 } };

@Controller('api/admin/bookings')
@UseGuards(AdminGuard)
export class AdminBookingsController {
  constructor(private readonly service: AdminBookingsService) {}

  @Throttle(READ) @Get()
  list(@Query() q: ListAdminBookingsDto) {
    return this.service.list(q);
  }

  @Throttle(READ) @Get(':id')
  detail(@Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string) {
    return this.service.detail(id);
  }

  @Throttle(WRITE) @Post(':id/cancel') @HttpCode(200)
  @ResponseMessage('Booking decision recorded.')
  cancel(
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
    @Body() dto: AdminCancelBookingDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.service.cancel(admin.userId, id, dto.reason, dto.amountToGuest, dto.refundMode);
  }
}
