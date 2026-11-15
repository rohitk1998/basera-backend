import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { MeetupsService } from './meetups.service';
import { CreateMeetupDto } from './dto/meetup-create.dto';
import { MeetupListQueryDto } from './dto/meetup-list-query.dto';

@Controller('api/meetups')
export class MeetupsController {
  constructor(
    private readonly meetups: MeetupsService,
    private readonly authGuard: AuthGuard,
  ) {}

  // Public: anonymous callers get joined=false and no member identities.
  @Get()
  async list(@Query() query: MeetupListQueryDto, @Req() req: Request) {
    let viewerId: string | undefined;
    try {
      viewerId = this.authGuard.verify(req).userId;
    } catch {
      viewerId = undefined;
    }
    const meetups = await this.meetups.list(query, viewerId);
    return { success: true, meetups };
  }

  @UseGuards(AuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ResponseMessage('Meetup created.')
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateMeetupDto) {
    const meetup = await this.meetups.create(user.userId, dto);
    return { meetup };
  }

  @UseGuards(AuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ResponseMessage('You are going.')
  @Post(':id/join')
  @HttpCode(200)
  async join(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const meetup = await this.meetups.join(user.userId, id);
    return { meetup };
  }

  @UseGuards(AuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ResponseMessage('You left the meetup.')
  @Delete(':id/join')
  async leave(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const meetup = await this.meetups.leave(user.userId, id);
    return { meetup };
  }
}
