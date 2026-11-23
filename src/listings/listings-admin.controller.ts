import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { BookingEligibilityService } from './booking-eligibility.service';
import { ListingHistoryService } from './listing-history.service';

@Controller('api/admin/listings')
@UseGuards(AdminGuard)
export class ListingsAdminController {
  constructor(
    private readonly eligibility: BookingEligibilityService,
    private readonly history: ListingHistoryService,
  ) {}

  @ResponseMessage('Booking eligibility updated.')
  @Patch(':id/booking-eligible')
  async setBookingEligible(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ) {
    return this.eligibility.set(id, user.userId, body);
  }

  @Get(':id/history')
  async historyOf(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, history: await this.history.list(id) };
  }
}
