import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListingEntity, ProfileEntity } from '../entities';
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
    @InjectRepository(ProfileEntity)
    private readonly profiles: Repository<ProfileEntity>,
    private readonly listingTranslations: ListingTranslationService,
  ) {}

  async findLive(params: {
    town?: string;
    category?: CategoryId;
    q?: string;
    locale?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ listings: Listing[]; towns: Town[]; total: number }> {
    // town/category/q still filter in-memory: they match against fields
    // derived from the jsonb draft_data blob (rowToListing), not real
    // columns, so they can't be pushed into SQL without a schema change.
    // Pagination is applied after that in-memory filter for the same
    // reason — this keeps the page one query instead of N, even though the
    // filter itself isn't index-backed yet.
    const rows = await this.listings.find({
      where: { status: 'live' },
      order: { created_at: 'DESC' },
    });

    const liveListings: Listing[] = rows.map(rowToListing);

    let filteredRows = rows.map((row, i) => ({ row, listing: liveListings[i] }));

    if (params.town) {
      const town = params.town.toLowerCase();
      filteredRows = filteredRows.filter((r) => r.listing.town.toLowerCase().includes(town));
    }

    if (params.category) {
      filteredRows = filteredRows.filter((r) => r.listing.categories.includes(params.category!));
    }

    if (params.q) {
      const q = params.q.toLowerCase();
      filteredRows = filteredRows.filter(
        (r) =>
          r.listing.title.toLowerCase().includes(q) ||
          r.listing.town.toLowerCase().includes(q) ||
          r.listing.description.toLowerCase().includes(q),
      );
    }

    const total = filteredRows.length;

    const pageSize = params.pageSize && params.pageSize > 0 ? Math.min(params.pageSize, 100) : filteredRows.length;
    const page = params.page && params.page > 0 ? params.page : 1;
    const pageRows = params.pageSize ? filteredRows.slice((page - 1) * pageSize, page * pageSize) : filteredRows;

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

    const distinctTownNames = Array.from(new Set(liveListings.map((l) => l.town)));
    const towns: Town[] = distinctTownNames.map((name) => {
      const inTown = liveListings.filter((l) => l.town === name);
      return {
        name,
        from: inTown.length > 0 ? Math.min(...inTown.map((l) => (l.dailyBaseRate * 30))) : 12000,
        listings: inTown,
      };
    });

    return { listings: filtered, towns, total };
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
