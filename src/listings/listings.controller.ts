import { Controller, Get, Logger, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { ListingsService } from './listings.service';
import { normalizeListingSearch } from './listing-search.util';
import { isSupportedLocale } from '../common/supported-locales';
import { AuthGuard } from '../auth/auth.guard';
import { UserEntity } from '../entities';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { PhoneRevealService } from './phone-reveal.service';
import { ResponseMessage } from '../common/decorators/response-message.decorator';

const MAGENTA = '\x1b[35m';
const RESET = '\x1b[0m';

@Controller('api/listings')
export class ListingsController {
  private readonly logger = new Logger(ListingsController.name);

  constructor(
    private readonly listingsService: ListingsService,
    private readonly authGuard: AuthGuard,
    private readonly phoneReveal: PhoneRevealService,
    @InjectRepository(UserEntity)
    private readonly profiles: Repository<UserEntity>,
  ) {}

  @Throttle({ default: { ttl: 60_000, limit: 600 } })
  @Get()
  async search(@Query() query: Record<string, unknown>) {
    const startedAt = Date.now();
    const params = normalizeListingSearch(query ?? {});
    const { locale } = params;
    const result = await this.listingsService.findLive({
      ...params,
      locale: isSupportedLocale(locale) ? locale : undefined,
    });

    const { listings, total, facets } = result as { listings?: unknown[]; total?: number; facets?: unknown };
    // Magenta, so search traffic stands out from Nest's green/yellow lines.
    this.logger.log(
      `${MAGENTA}GET /api/listings ${JSON.stringify(query ?? {})} -> ${listings?.length ?? 0} of ${total ?? '?'}` +
        `${facets ? ' +facets' : ''} in ${Date.now() - startedAt}ms${RESET}`,
    );

    return { success: true, ...result };
  }

  @Get('towns')
  async towns() {
    const towns = await this.listingsService.getTownSummaries();
    return { success: true, towns };
  }

  /** "Call Host": the only way a phone number leaves the server. Verified guests, 3 unique hosts / 24h. */
  @UseGuards(AuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ResponseMessage('Host number ready.')
  @Post(':id/reveal-phone')
  async revealPhone(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.phoneReveal.reveal(user.userId, id, req.ip);
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
