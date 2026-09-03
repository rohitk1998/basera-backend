import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { SubscriptionsService } from './subscriptions.service';
import { SubscribeDto } from './dto/subscribe.dto';

@Controller('api/subscriptions')
@UseGuards(AuthGuard)
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Get('me')
  getMine(@CurrentUser() user: AuthUser) {
    return this.subscriptionsService.getForHost(user.userId);
  }

  @Post('subscribe')
  subscribe(@CurrentUser() user: AuthUser, @Body() dto: SubscribeDto) {
    return this.subscriptionsService.subscribe(user.userId, dto.planId);
  }

  @Post('cancel')
  cancel(@CurrentUser() user: AuthUser) {
    return this.subscriptionsService.cancel(user.userId);
  }
}
