import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { ListingsService } from './listings.service';
import { normalizeListingSearch } from './listing-search.util';
import { isSupportedLocale } from '../common/supported-locales';
import { AuthGuard } from '../auth/auth.guard';
import { UserEntity } from '../entities';

@Controller('api/listings')
export class ListingsController {
  constructor(
    private readonly listingsService: ListingsService,
    private readonly authGuard: AuthGuard,
    @InjectRepository(UserEntity)
    private readonly profiles: Repository<UserEntity>,
  ) {}

  @Throttle({ default: { ttl: 60_000, limit: 600 } })
  @Get()
  async search(@Query() query: Record<string, unknown>) {
    const params = normalizeListingSearch(query ?? {});
    const { locale } = params;
    const result = await this.listingsService.findLive({
      ...params,
      locale: isSupportedLocale(locale) ? locale : undefined,
    });

    return { success: true, ...result };
  }

  @Get('towns')
  async towns() {
    const towns = await this.listingsService.getTownSummaries();
    return { success: true, towns };
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Query('locale') locale?: string, @Req() req?: Request) {
    let viewer: { userId: string; isAdmin: boolean } | undefined;
    if (req) {
      try {
        const user = this.authGuard.verify(req);
        const profile = await this.profiles.findOne({ where: { id: user.userId } });
        viewer = { userId: user.userId, isAdmin: profile?.role === 'admin' };
      } catch {
        viewer = undefined;
      }
    }

    const { listing, host } = await this.listingsService.findOnePublic(
      id,
      isSupportedLocale(locale) ? locale : undefined,
      viewer,
    );
    return { success: true, listing, host };
  }

  @Get(':id/availability')
  async availability(@Param('id') id: string) {
    const bookedRanges = await this.listingsService.getBookedRanges(id);
    return { success: true, bookedRanges };
  }
}
