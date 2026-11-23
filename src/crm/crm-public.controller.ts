import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { CrmService } from './crm.service';
import { HostRegistrationDto, OptOutDto, VerifyTokenQueryDto } from './dto/crm.dto';

/** Unauthenticated endpoints. Every one is rate limited. */
@Controller('api/crm')
export class CrmPublicController {
  constructor(private readonly crm: CrmService) {}

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Get('invitations/verify')
  verify(@Query() q: VerifyTokenQueryDto) { return this.crm.verifyInvitation(q.token); }

  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  @HttpCode(201)
  @ResponseMessage('Thanks. Our team will contact you.')
  @Post('host-registrations')
  register(@Body() dto: HostRegistrationDto) { return this.crm.selfRegister(dto); }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(200)
  @ResponseMessage('You have been opted out. We will not contact you again.')
  @Post('opt-out')
  optOut(@Body() dto: OptOutDto) { return this.crm.optOutByToken(dto.token); }
}
