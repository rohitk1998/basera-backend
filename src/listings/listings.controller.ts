import { Controller, Get, Param, Query } from '@nestjs/common';
import { ListingsService } from './listings.service';
import type { CategoryId } from './listing.types';
import { isSupportedLocale } from '../common/supported-locales';

/**
 * Public browse/detail. Ported from web/app/api/listings/route.ts and
 * web/app/api/listings/[id]/route.ts — no auth required.
 */
@Controller('api/listings')
export class ListingsController {
  constructor(private readonly listingsService: ListingsService) {}

  @Get()
  async search(
    @Query('town') town?: string,
    @Query('category') category?: CategoryId,
    @Query('q') q?: string,
    @Query('guests') guests?: string,
    @Query('sort') sort?: string,
    @Query('locale') locale?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const { listings, total } = await this.listingsService.findLive({
      town,
      category,
      q: q?.toLowerCase(),
      minGuests: guests ? Number.parseInt(guests, 10) || undefined : undefined,
      sortByTrust: sort === 'trust',
      locale: isSupportedLocale(locale) ? locale : undefined,
      page: page ? Number.parseInt(page, 10) || undefined : undefined,
      pageSize: pageSize ? Number.parseInt(pageSize, 10) || undefined : undefined,
    });

    return { success: true, listings, total };
  }

  // Per-town aggregate (name/cheapest price/total count/bounded preview) —
  // a cheap SQL group-by, not a full-catalogue fetch-and-map. Replaces the
  // frontend's old getLiveTowns(), which used to re-derive this by fetching
  // every live listing a second time.
  @Get('towns')
  async towns() {
    const towns = await this.listingsService.getTownSummaries();
    return { success: true, towns };
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Query('locale') locale?: string) {
    const { listing, host } = await this.listingsService.findOnePublic(
      id,
      isSupportedLocale(locale) ? locale : undefined,
    );
    return { success: true, listing, host };
  }
}
