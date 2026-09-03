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
    @Query('locale') locale?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const { listings, towns, total } = await this.listingsService.findLive({
      town,
      category,
      q: q?.toLowerCase(),
      locale: isSupportedLocale(locale) ? locale : undefined,
      page: page ? Number.parseInt(page, 10) || undefined : undefined,
      pageSize: pageSize ? Number.parseInt(pageSize, 10) || undefined : undefined,
    });

    return { success: true, listings, towns, total };
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
