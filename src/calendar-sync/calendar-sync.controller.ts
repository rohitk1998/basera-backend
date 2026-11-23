import { BadRequestException, Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { CalendarSyncService } from './calendar-sync.service';

/** Public, token-gated feed. Calendar apps poll it without cookies. */
@Controller('api/calendar')
export class CalendarFeedController {
  constructor(private readonly service: CalendarSyncService) {}

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Get(':listingId/:file')
  @Header('Content-Type', 'text/calendar; charset=utf-8')
  @Header('Cache-Control', 'private, max-age=300')
  feed(@Param('listingId', ParseUUIDPipe) listingId: string, @Param('file') file: string) {
    if (!file.endsWith('.ics')) throw new BadRequestException('Expected a .ics link.');
    return this.service.buildFeed(listingId, file.slice(0, -'.ics'.length));
  }
}

@Controller('api/host/listings/:listingId/calendar')
@UseGuards(AuthGuard)
export class HostCalendarSyncController {
  constructor(private readonly service: CalendarSyncService) {}

  @Get()
  async get(@Param('listingId', ParseUUIDPipe) listingId: string, @CurrentUser() user: AuthUser) {
    return { success: true, ...(await this.service.getStatus(listingId, user.userId)) };
  }

  @ResponseMessage('Calendar link saved.')
  @Put()
  async setUrl(
    @Param('listingId', ParseUUIDPipe) listingId: string,
    @Body('importUrl') importUrl: unknown,
    @CurrentUser() user: AuthUser,
  ) {
    if (importUrl !== null && typeof importUrl !== 'string') throw new BadRequestException('importUrl must be a string or null.');
    return this.service.setImportUrl(listingId, user.userId, importUrl);
  }

  @ResponseMessage('Calendar synced.')
  @Post('sync')
  syncNow(@Param('listingId', ParseUUIDPipe) listingId: string, @CurrentUser() user: AuthUser) {
    return this.service.syncNow(listingId, user.userId);
  }

  @ResponseMessage('Export link rotated. Update it in your other calendars.')
  @Post('rotate-token')
  rotate(@Param('listingId', ParseUUIDPipe) listingId: string, @CurrentUser() user: AuthUser) {
    return this.service.rotateToken(listingId, user.userId);
  }
}
