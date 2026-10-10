import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { ListingsService } from './listings.service';
import { normalizeListingSearch } from './listing-search.util';
import { isSupportedLocale } from '../common/supported-locales';
import { AuthGuard } from '../auth/auth.guard';
import { UserEntity } from '../entities';

/**
 * Public browse/detail. Ported from web/app/api/listings/route.ts and
 * web/app/api/listings/[id]/route.ts — no auth required.
 */
@Controller('api/listings')
export class ListingsController {
  constructor(
    private readonly listingsService: ListingsService,
    private readonly authGuard: AuthGuard,
    @InjectRepository(UserEntity)
    private readonly profiles: Repository<UserEntity>,
  ) {}

  /**
   * The one listing list/search/filter endpoint. All params optional and
   * AND-combined: `q` (free text over place, district, tehsil, property name;
   * `town`/`location` are old aliases), `district` (must be an HP district),
   * `tehsil`, `category`, `guests`, `date`, `dateEnd`, `sort=trust`, `locale`,
   * `page`, `pageSize` (default 48, max 200) and `facets=1` for per-district /
   * per-place counts. Bad values are ignored, never a 4xx/5xx — see
   * normalizeListingSearch().
   *
   * Takes the raw query object (not individual @Query params) because a
   * repeated `?q=a&q=b` arrives as an array.
   */
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

  /**
   * @deprecated Use GET /api/listings?facets=1 (facets.places for names,
   * counts and "from" prices; `listings` for previews). Kept as a thin
   * wrapper over the same query for the Expo app and web builds that have
   * not migrated yet; remove once nothing calls it (loadtest.mjs also does).
   */
  @Get('towns')
  async towns() {
    const towns = await this.listingsService.getTownSummaries();
    return { success: true, towns };
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Query('locale') locale?: string, @Req() req?: Request) {
    // Auth here is optional, not required: an anonymous guest must still be
    // able to load a live listing. A present-but-invalid/expired cookie is
    // treated the same as no cookie — this endpoint never 401s, it only
    // narrows what a non-live listing shows.
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

  // Public: date ranges already occupied by a real booking, for a guest's
  // date picker to grey out before they attempt to book. No auth — this is
  // browse-time availability info, same trust level as the listing itself.
  @Get(':id/availability')
  async availability(@Param('id') id: string) {
    const bookedRanges = await this.listingsService.getBookedRanges(id);
    return { success: true, bookedRanges };
  }
}
