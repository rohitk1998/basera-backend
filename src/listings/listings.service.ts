import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListingEntity, UserEntity } from '../entities';
import { rowToListing } from './listing-mapper';
import { CategoryId, Listing, Town } from './listing.types';
import { ListingTranslationService } from './listing-translation.service';

export type ListingHostInfo = {
  id: string;
  name: string;
  phone: string;
  avatarUrl?: string;
  joinedYear: number;
  trustScore: number | null;
  tier: null;
};

/**
 * Public browse/detail queries. Ported from web/app/api/listings/route.ts and
 * web/app/api/listings/[id]/route.ts. The mock-catalogue fallback in
 * lib/listings.server.ts is deliberately dropped here — this is a real
 * backend against a real database, so zero live listings means an empty
 * result, not fiction standing in for it.
 */
@Injectable()
export class ListingsService {
  constructor(
    @InjectRepository(ListingEntity)
    private readonly listings: Repository<ListingEntity>,
    @InjectRepository(UserEntity)
    private readonly profiles: Repository<UserEntity>,
    private readonly listingTranslations: ListingTranslationService,
  ) {}

  /**
   * Pushes status/town/category/q filtering into SQL against the jsonb
   * draft_data column, and applies LIMIT/OFFSET at the DB level for the
   * actual page — so a page of 100 out of several thousand live listings
   * only ever fetches and maps 100 rows, not the whole catalogue. This
   * used to fetch every live row unconditionally and filter/paginate in
   * memory (fine at a few dozen listings, a 20+ second full-catalogue
   * scan-and-map at a few thousand). The `towns` field this method used to
   * return was dead — the frontend (lib/listings.server.ts getLiveTowns())
   * never read it, deriving town data by re-fetching and re-deriving from
   * the full unpaginated listing set instead. See getTownSummaries() below
   * for the real replacement: a dedicated, cheap per-town aggregate that
   * doesn't require mapping every live listing either.
   */
  async findLive(params: {
    town?: string;
    category?: CategoryId;
    q?: string;
    minGuests?: number;
    sortByTrust?: boolean;
    locale?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ listings: Listing[]; total: number }> {
    const qb = this.listings.createQueryBuilder('l').where('l.status = :status', { status: 'live' });

    if (params.town) {
      qb.andWhere("l.draft_data->'property_details'->>'town' ILIKE :town", { town: `%${params.town}%` });
    }
    if (params.category) {
      // jsonb array membership — property_details.categories is a plain
      // JSON string array (see listing-schema.ts / listing-mapper.ts).
      qb.andWhere("l.draft_data->'property_details'->'categories' @> :category", {
        category: JSON.stringify([params.category]),
      });
    }
    if (params.q) {
      qb.andWhere(
        "(l.draft_data->'property_details'->>'title' ILIKE :q OR l.draft_data->'property_details'->>'town' ILIKE :q OR l.draft_data->'property_details'->>'description' ILIKE :q)",
        { q: `%${params.q}%` },
      );
    }
    if (params.minGuests) {
      qb.andWhere("(l.draft_data->'property_details'->>'maxGuests')::int >= :minGuests", {
        minGuests: params.minGuests,
      });
    }

    const total = await qb.getCount();

    // No pageSize at all means "give me everything that matches" (SSG's
    // generateStaticParams needs every id; a handful of legacy callers
    // still rely on this) — genuinely unbounded, not capped to 100 like an
    // explicit pageSize is. Callers serving a browse page should always
    // pass pageSize; the browse page itself now does (see app/stays).
    const pageSize = params.pageSize && params.pageSize > 0 ? Math.min(params.pageSize, 100) : total;
    const page = params.page && params.page > 0 ? params.page : 1;

    qb.orderBy(
      params.sortByTrust ? "(l.draft_data->>'trustScore')::int" : 'l.created_at',
      params.sortByTrust ? 'DESC' : 'DESC',
    );
    if (params.sortByTrust) {
      // trustScore ties (or a null on an old draft) still need a stable
      // secondary order, or pagination pages could reshuffle between
      // requests.
      qb.addOrderBy('l.created_at', 'DESC');
    }

    const rows = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();

    const pageRows = rows.map((row) => ({ row, listing: rowToListing(row) }));

    // Never block the list response on translation: a page-worth of
    // listings is translated with a single batched cache lookup (one Redis
    // round-trip per item, one Postgres query for whatever misses Redis)
    // instead of N sequential queries; anything still missing after that
    // is served in its original language and warmed in the background.
    let filtered: Listing[];
    if (params.locale) {
      const translated = await this.listingTranslations.getCachedTranslationsBatch(pageRows, params.locale);
      filtered = pageRows.map(({ listing, row }) => {
        const hit = translated.get(listing.id);
        if (hit) return hit;
        this.listingTranslations.warmTranslation(listing, row, params.locale!);
        return listing;
      });
    } else {
      filtered = pageRows.map((r) => r.listing);
    }

    return { listings: filtered, total };
  }

  /**
   * Per-town aggregate for the homepage/browse-town pages: name, cheapest
   * monthly rate, total live count, and a bounded preview of mapped
   * listings (previewPerTown, not every listing in the town — town.listings
   * renders as real cards, see app/page.tsx and app/stays/town/[slug]). The
   * MIN/COUNT are computed in SQL over the jsonb path so they don't require
   * mapping a single row; only the preview rows actually get mapped.
   */
  async getTownSummaries(previewPerTown = 12): Promise<Town[]> {
    const townRows: { town: string; total: string; from: string }[] = await this.listings
      .createQueryBuilder('l')
      .select("l.draft_data->'property_details'->>'town'", 'town')
      .addSelect('COUNT(*)', 'total')
      .addSelect("MIN((l.draft_data->'property_details'->>'dailyBaseRate')::numeric)", 'from')
      .where('l.status = :status', { status: 'live' })
      .groupBy("l.draft_data->'property_details'->>'town'")
      .getRawMany();

    const towns = await Promise.all(
      townRows
        .filter((r) => r.town)
        .map(async (r) => {
          const rows = await this.listings
            .createQueryBuilder('l')
            .where('l.status = :status', { status: 'live' })
            .andWhere("l.draft_data->'property_details'->>'town' = :town", { town: r.town })
            .orderBy('l.created_at', 'DESC')
            .take(previewPerTown)
            .getMany();

          return {
            name: r.town,
            from: Math.round(Number(r.from) * 30),
            total: Number(r.total),
            listings: rows.map(rowToListing),
          };
        }),
    );

    return towns;
  }

  async findOnePublic(id: string, locale?: string): Promise<{ listing: Listing; host: ListingHostInfo }> {
    const row = await this.listings.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Listing not found');
    }

    const hostProfile = await this.profiles.findOne({ where: { id: row.host_id } });
    let listing = rowToListing(row);

    if (locale) {
      listing = await this.listingTranslations.getTranslatedListing(listing, row, locale);
    }

    return {
      listing,
      host: {
        id: row.host_id,
        // No invented name, phone or tier when the profile lookup misses —
        // a wrong host attached to a real listing is worse than an absent one.
        name: hostProfile?.full_name || 'Host',
        phone: hostProfile?.phone || '',
        avatarUrl: hostProfile?.avatar_url || undefined,
        joinedYear: hostProfile?.created_at
          ? new Date(hostProfile.created_at).getFullYear()
          : new Date().getFullYear(),
        trustScore: listing.trust,
        tier: null,
      },
    };
  }
}
