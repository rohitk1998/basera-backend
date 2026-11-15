import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { GuestProfileService } from './guest-profile.service';
import { UpdateGuestProfileDto } from './dto/update-guest-profile.dto';

@Controller('api/social')
export class GuestProfileController {
  constructor(private readonly profiles: GuestProfileService) {}

  @UseGuards(AuthGuard)
  @Get('profile')
  getProfile(@CurrentUser() user: AuthUser) {
    return this.profiles.getProfile(user.userId);
  }

  @UseGuards(AuthGuard)
  @ResponseMessage('Profile saved.')
  @Put('profile')
  updateProfile(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateGuestProfileDto,
  ) {
    return this.profiles.updateProfile(user.userId, dto);
  }

  @Get('listings/:listingId/summary')
  getSummary(@Param('listingId') listingId: string) {
    return this.profiles.getListingSummary(listingId);
  }

  @UseGuards(AuthGuard)
  @Get('listings/:listingId/guests')
  listGuests(
    @CurrentUser() user: AuthUser,
    @Param('listingId') listingId: string,
  ) {
    return this.profiles.listGuests(user.userId, listingId);
  }
}
