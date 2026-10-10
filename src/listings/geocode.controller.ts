import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { GeocodeService } from './geocode.service';

/**
 * "Find on map" for the host listing form (web and app): district + tehsil +
 * what the host typed -> a pin, as exact as the data allows. Logged-in users
 * only, and throttled, because each lookup reaches a shared public service.
 */
@Controller('api/geocode')
@UseGuards(AuthGuard)
export class GeocodeController {
  constructor(private readonly geocode: GeocodeService) {}

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Get()
  async locate(
    @Query('district') district = '',
    @Query('tehsil') tehsil = '',
    @Query('q') q = '',
  ) {
    const result = await this.geocode.locate({ district, tehsil, query: q });
    return { success: true, ...result };
  }

  /** The address of a pin the host placed or dragged, so the form can show it back. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('reverse')
  async reverse(@Query('lat') lat = '', @Query('lng') lng = '') {
    const toNumber = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    const result = await this.geocode.reverse(toNumber(lat), toNumber(lng));
    return { success: true, ...result };
  }
}
