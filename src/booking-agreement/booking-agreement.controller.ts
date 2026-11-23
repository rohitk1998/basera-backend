import { Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { BookingAgreementService } from './booking-agreement.service';

@Controller('api/bookings/:id/agreement')
@UseGuards(AuthGuard)
export class BookingAgreementController {
  constructor(private readonly agreements: BookingAgreementService) {}

  @Get()
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
  ) {
    return this.agreements.get(user.userId, id);
  }

  @ResponseMessage('Agreement acknowledged.')
  @Post('ack')
  ack(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
    @Req() req: Request,
  ) {
    return this.agreements.acknowledge(user.userId, id, req.ip);
  }
}
