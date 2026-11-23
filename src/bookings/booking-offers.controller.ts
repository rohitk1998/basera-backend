import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { BookingOffersService } from './booking-offers.service';
import { CreateOfferDto, DeclineOfferDto } from './dto/offer.dto';

const uuid = () => new ParseUUIDPipe({ errorHttpStatusCode: 404 });

@Controller('api/bookings/:id')
@UseGuards(AuthGuard)
export class BookingOffersController {
  constructor(private readonly offers: BookingOffersService) {}

  @Get('offer')
  get(@CurrentUser() user: AuthUser, @Param('id', uuid()) id: string) {
    return this.offers.getOffer(user.userId, id);
  }

  @ResponseMessage('Booking marked as under review.')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post('review')
  review(@CurrentUser() user: AuthUser, @Param('id', uuid()) id: string) {
    return this.offers.markReview(user.userId, id);
  }

  @ResponseMessage('Offer sent.')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('offer')
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid()) id: string,
    @Body() dto: CreateOfferDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.offers.createOffer(user.userId, id, dto, key);
  }

  @ResponseMessage('Offer accepted. Complete payment to confirm.')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('offer/accept')
  accept(@CurrentUser() user: AuthUser, @Param('id', uuid()) id: string, @Headers('idempotency-key') key?: string) {
    return this.offers.acceptOffer(user.userId, id, key);
  }

  @ResponseMessage('Offer declined.')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('offer/decline')
  decline(@CurrentUser() user: AuthUser, @Param('id', uuid()) id: string, @Body() dto: DeclineOfferDto) {
    return this.offers.declineOffer(user.userId, id, dto.reason);
  }

  @ResponseMessage('Offer withdrawn.')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('offer/withdraw')
  withdraw(@CurrentUser() user: AuthUser, @Param('id', uuid()) id: string, @Body() dto: DeclineOfferDto) {
    return this.offers.withdrawOffer(user.userId, id, dto.reason);
  }
}

/** Admin may set a total outside the host's +/- bound (support / dispute settlement). */
@Controller('api/admin/bookings/:id')
@UseGuards(AdminGuard)
export class AdminBookingOffersController {
  constructor(private readonly offers: BookingOffersService) {}

  @ResponseMessage('Offer sent.')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('offer')
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid()) id: string,
    @Body() dto: CreateOfferDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.offers.createOffer(user.userId, id, dto, key, true);
  }
}
