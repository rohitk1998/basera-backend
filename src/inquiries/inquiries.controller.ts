import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'crypto';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { CreateInquiryDto, CreateMyInquiryDto } from './dto/create-inquiry.dto';
import { InquiriesService } from './inquiries.service';
import { generatePublicRef } from './inquiry.util';

/** Public, unauthenticated. Request-only: nothing here can book or take payment. */
@Controller('api/inquiries')
export class InquiriesController {
  constructor(private readonly service: InquiriesService) {}

  @Post()
  @HttpCode(201)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ResponseMessage('Request received. No payment was taken.')
  async create(@Body() dto: CreateInquiryDto) {
    if (dto.website && dto.website.trim() !== '') {
      // Honeypot tripped: answer like a success so bots learn nothing, store nothing.
      return { publicRef: generatePublicRef(), accessToken: randomBytes(32).toString('base64url'), duplicate: false };
    }
    return this.service.create(dto);
  }

  /** Signed-in guests only: contact details come from the account, so there is no form to fill. */
  @Post('me')
  @UseGuards(AuthGuard)
  @HttpCode(201)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ResponseMessage('Request received. No payment was taken.')
  createMine(@CurrentUser() user: AuthUser, @Body() dto: CreateMyInquiryDto) {
    return this.service.createForUser(user.userId, dto, { tokenPhone: user.phone });
  }

  @Get(':ref')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  get(@Param('ref') ref: string, @Query('token') token?: string) {
    return this.service.getPublic(ref, token);
  }
}
