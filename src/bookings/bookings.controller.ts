import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { ListBookingsQueryDto } from './dto/list-bookings-query.dto';
import { CheckinBookingDto } from './dto/checkin-booking.dto';
import { DisputeBookingDto } from './dto/dispute-booking.dto';
import { DisputeOfferDto } from './dto/dispute-offer.dto';
import { DisputeRespondDto } from './dto/dispute-respond.dto';
import { DisputeAppealDto } from './dto/dispute-appeal.dto';
import { DeclineBookingDto } from './dto/decline-booking.dto';
import { ResponseMessage } from '../common/decorators/response-message.decorator';

interface UploadedMulterFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

@Controller('api/bookings')
@UseGuards(AuthGuard)
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @ResponseMessage('Booking request sent to the host.')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateBookingDto) {
    return this.bookingsService.create(user.userId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListBookingsQueryDto) {
    const role = query.role === 'host' ? 'host' : 'guest';
    return this.bookingsService.list(user.userId, role, {
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    });
  }

  @Get(':id')
  getById(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
  ) {
    return this.bookingsService.getById(user.userId, id);
  }

  @ResponseMessage('Booking approved.')
  @Post(':id/approve')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bookingsService.approve(user.userId, id);
  }

  @ResponseMessage('Booking declined.')
  @Post(':id/decline')
  decline(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DeclineBookingDto) {
    return this.bookingsService.decline(user.userId, id, dto.reason);
  }

  @ResponseMessage('Booking cancelled.')
  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bookingsService.cancel(user.userId, id);
  }

  @ResponseMessage('Payment started.')
  @Post(':id/pay')
  pay(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bookingsService.pay(user.userId, id);
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Get(':id/payment')
  paymentStatus(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bookingsService.getPaymentStatus(user.userId, id);
  }

  @ResponseMessage('Check-in confirmed.')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post(':id/checkin')
  checkin(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CheckinBookingDto) {
    return this.bookingsService.checkin(user.userId, id, dto.code);
  }

  @ResponseMessage('Dispute raised. We will look into it.')
  @Post(':id/dispute')
  dispute(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DisputeBookingDto) {
    return this.bookingsService.dispute(user.userId, id, dto);
  }

  @Get(':id/dispute')
  getDispute(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bookingsService.getDisputeCase(user.userId, id);
  }

  @ResponseMessage('Evidence uploaded.')
  @Post(':id/dispute/evidence')
  @UseInterceptors(FilesInterceptor('files', 6))
  addDisputeEvidence(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFiles() files?: UploadedMulterFile[],
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files provided');
    }
    return this.bookingsService.addDisputeEvidence(user.userId, id, files);
  }

  @ResponseMessage('Offer sent.')
  @Post(':id/dispute/offer')
  makeDisputeOffer(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DisputeOfferDto) {
    return this.bookingsService.makeDisputeOffer(user.userId, id, dto.amountToGuest, dto.message);
  }

  @ResponseMessage((_r, req) => ({ accept: 'Offer accepted.', reject: 'Offer rejected.', escalate: 'Dispute escalated for review.' } as Record<string, string>)[req.body?.action] ?? 'Response recorded.')
  @Post(':id/dispute/respond')
  respondToDisputeOffer(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DisputeRespondDto) {
    return this.bookingsService.respondToDisputeOffer(user.userId, id, dto.action);
  }

  @ResponseMessage('Appeal submitted.')
  @Post(':id/dispute/appeal')
  appealDispute(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DisputeAppealDto) {
    return this.bookingsService.appealDispute(user.userId, id, dto.message);
  }

  @ResponseMessage('Check-out recorded.')
  @Post(':id/checkout')
  checkout(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bookingsService.checkout(user.userId, id);
  }
}
