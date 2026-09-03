import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { HostListingsService } from './host-listings.service';

/**
 * Host-facing listing management. Ported from web/app/api/host/listings/
 * route.ts, .../[id]/route.ts and .../submit-full/route.ts. No notifications
 * are sent from any of these routes in the original — only admin review and
 * booking actions do that.
 */
@Controller('api/host/listings')
@UseGuards(AuthGuard)
export class HostListingsController {
  constructor(private readonly hostListingsService: HostListingsService) {}

  @Get()
  async findMine(@CurrentUser() user: AuthUser) {
    const listings = await this.hostListingsService.findMine(user.userId);
    return { success: true, listings };
  }

  // Registered before the `:id` routes below — Nest/Express match routes in
  // declaration order, and "submit-full" would otherwise be swallowed as an
  // `:id` value.
  @Post('submit-full')
  async submitFull(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const { listingId, status } = await this.hostListingsService.submitFull(user.userId, body);
    return { success: true, listingId, status };
  }

  @Get(':id')
  async findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const listing = await this.hostListingsService.findMineById(user.userId, id);
    return { success: true, listing };
  }

  @Patch(':id')
  async resubmit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { listingId, status } = await this.hostListingsService.resubmit(user.userId, id, body);
    return { success: true, listingId, status };
  }
}
