import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { GeocodeService } from './geocode.service';

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

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('reverse')
  async reverse(@Query('lat') lat = '', @Query('lng') lng = '') {
    const toNumber = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    const result = await this.geocode.reverse(toNumber(lat), toNumber(lng));
    return { success: true, ...result };
  }
}
