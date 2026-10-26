import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { ListingEntity, UserEntity, BookingEntity } from '../entities';
import { agreeTerms } from '../common/domain';
import { rowToListing } from './listing-mapper';
import { Listing, Town } from './listing.types';
import { HP_DISTRICTS, HP_LOCATIONS, tehsilsOf } from './hp-locations';
import { PLACE_ALIASES } from './place-aliases';
import { PlaceVocab, buildPlaceVocab, correctPlaceQuery, nearbyPlaceFor, spellingVariantFor } from './place-fuzzy';
import { ListingSearchParams, PD, buildTextCondition, clampPagination, pd } from './listing-search.util';
import { ListingTranslationService } from './listing-translation.service';
import { captureCheckTrulyPassed } from './capture-evidence.util';
import { RedisService } from '../redis/redis.service';
import { Semaphore, withTimeout, withTransientRetry } from './db-resilience';

export type ListingHostInfo = {
  id: string;
  name: string;
  phone: string;
  avatarUrl?: string;
  joinedYear: number;
  trustScore: number | null;
  tier: null;
};

export type DistrictFacet = { name: string; count: number; coverUrl?: string };

export type PlaceFacet = { district: string; tehsil: string; count: number; fromMonthlyRent: number | null };
export type ListingFacets = { districts: DistrictFacet[]; places: PlaceFacet[] };
export type LiveSearchResult = {
  listings: Listing[];
  total: number;
  page: number;
  pageSize: number;
  facets?: ListingFacets;

  searchedQuery?: string;
  resolvedQuery?: string;
  didYouMean?: string;

  autoCorrected?: boolean;
  nearby?: { name: string; parent: string };
};

const DISTRICT_SQL = `COALESCE(trim(${pd('district')}), '')`;
const PLACE_SQL = `COALESCE(NULLIF(trim(${pd('tehsil')}), ''), NULLIF(trim(${pd('town')}), ''), NULLIF(trim(${pd('city')}), ''))`;

const COVER_PHOTO_SQL = `NULLIF(trim(${PD}->'photos'->0->>'url'), '')`;
const COVER_SQL = `(array_agg(${COVER_PHOTO_SQL} ORDER BY l.created_at, l.id) FILTER (WHERE ${COVER_PHOTO_SQL} IS NOT NULL))[1]`;
const COVER_AT_SQL = `MIN(l.created_at) FILTER (WHERE ${COVER_PHOTO_SQL} IS NOT NULL)`;
const RATE_SQL = `NULLIF(${pd('dailyBaseRate')}, '')::numeric`;
const DISC_SQL = `COALESCE(NULLIF(${pd('monthlyDiscountPct')}, '')::numeric, 40)`;
const EFFECTIVE_SQL = `${RATE_SQL} * (1 - ${DISC_SQL} / 100)`;

type PlaceFacetRow = { district: string; place: string | null; count: string; min_rate: string | null; min_disc: string | null };

function canonicalDistrictName(raw: string): string {
  const name = raw.trim();
  return HP_DISTRICTS.find((d) => d.toLowerCase() === name.toLowerCase()) ?? name;
}

function canonicalTehsilName(district: string, raw: string): string {
  const name = raw.trim();
  return tehsilsOf(district).find((t) => t.toLowerCase() === name.toLowerCase()) ?? name;
}

export const SEARCH_CACHE_VERSION_KEY = 'listings:search:version';

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);

  private static readonly OCCUPYING_BOOKING_STATUSES = [
    'confirmed',
    'checked_in',
    'disputed',
    'completed',
    'checked_out',
  ];

  private static readonly SEARCH_CACHE_TTL_SECONDS = 30;
  private static readonly TOWN_SUMMARIES_CACHE_TTL_SECONDS = 60;
  private readonly inFlightSearches = new Map<string, Promise<LiveSearchResult>>();
  private static readonly FACETS_CACHE_TTL_SECONDS = 60;

  private static readonly CACHE_READ_TIMEOUT_MS = 300;

  private readonly dbSearchSlots = new Semaphore(4, 3_000);

  constructor(
    @InjectRepository(ListingEntity)
    private readonly listings: Repository<ListingEntity>,
    @InjectRepository(UserEntity)
    private readonly profiles: Repository<UserEntity>,
    @InjectRepository(BookingEntity)
    private readonly bookings: Repository<BookingEntity>,
    private readonly listingTranslations: ListingTranslationService,
    private readonly redis: RedisService,
  ) {}

  async bumpSearchCacheVersion(): Promise<void> {
    await this.redis.incrementVersion(SEARCH_CACHE_VERSION_KEY);
  }

  async findLive(params: ListingSearchParams): Promise<LiveSearchResult> {

    const key = JSON.stringify(Object.entries(params).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
    const running = this.inFlightSearches.get(key);
    if (running) return running;
    const promise = this.findLiveWithHints(params).finally(() => this.inFlightSearches.delete(key));
    this.inFlightSearches.set(key, promise);
    return promise;
  }

  private async findLiveWithHints(params: ListingSearchParams): Promise<LiveSearchResult> {
    const first = await this.findLiveUncoalesced(params);
    const q = params.q;
    if (!q || params.exact) return first;
    if (first.total > 0) {
      const near = nearbyPlaceFor(q);
      const variant = spellingVariantFor(q);
      if (variant) {
        const vNear = nearbyPlaceFor(variant);
        return {
          ...first,
          searchedQuery: q,
          resolvedQuery: variant,
          didYouMean: variant,
          ...(vNear ? { nearby: { name: vNear.label, parent: vNear.parent } } : {}),
        };
      }
      return near ? { ...first, nearby: { name: near.label, parent: near.parent } } : first;
    }
    let corrected: string | undefined;
    try {
      corrected = correctPlaceQuery(q, await this.placeVocab())?.query;
    } catch (err) {
      this.logger.warn(`place vocabulary unavailable, skipping did-you-mean: ${err instanceof Error ? err.message : err}`);
    }
    if (!corrected || corrected.toLowerCase() === q.toLowerCase()) return first;
    const retry = await this.findLiveUncoalesced({ ...params, q: corrected });
    if (retry.total === 0) return first;
    const near = nearbyPlaceFor(corrected);
    return {
      ...retry,
      searchedQuery: q,
      resolvedQuery: corrected,
      didYouMean: corrected,
      autoCorrected: true,
      ...(near ? { nearby: { name: near.label, parent: near.parent } } : {}),
    };
  }

  private placeVocabCache: { at: number; vocab: PlaceVocab } | null = null;

  private async placeVocab(): Promise<PlaceVocab> {
    const cached = this.placeVocabCache;
    if (cached && Date.now() - cached.at < ListingsService.TOWN_SUMMARIES_CACHE_TTL_SECONDS * 1000) return cached.vocab;
    const names: string[] = [...HP_DISTRICTS, ...Object.keys(PLACE_ALIASES)];
    for (const d of HP_DISTRICTS) names.push(...HP_LOCATIONS[d].tehsils);
    const fields = ['town', 'locality', 'city', 'tehsil'] as const;
    const sql = fields.map((f) => `SELECT DISTINCT trim(${pd(f)}) AS name FROM listings l WHERE l.status = 'live'`).join(' UNION ');
    const rows: { name: string | null }[] = await this.listings.query(sql);
    for (const r of rows) if (r.name) names.push(r.name);
    const vocab = buildPlaceVocab(names);
    this.placeVocabCache = { at: Date.now(), vocab };
    return vocab;
  }

  private async findLiveUncoalesced(params: ListingSearchParams): Promise<LiveSearchResult> {
    const normalized: ListingSearchParams = {
      ...params,
      ...clampPagination(params.page, params.pageSize),
      facets: params.facets === true,
    };

    if (!normalized.moveIn) {

      let cacheKey: string | null = null;
      try {
        cacheKey = await this.searchCacheKey(normalized);
        const cached = await this.cacheGet(cacheKey);
        if (cached) return JSON.parse(cached);
      } catch (err) {
        this.logger.warn(`listings search cache read failed: ${err instanceof Error ? err.message : err}`);
      }

      const result = await this.searchDb(normalized);
      if (cacheKey) {

        void this.redis.set(cacheKey, JSON.stringify(result), ListingsService.SEARCH_CACHE_TTL_SECONDS);
      }
      return result;
    }

    return this.searchDb(normalized);
  }

  private cacheGet(key: string): Promise<string | null> {
    return withTimeout(this.redis.get(key), ListingsService.CACHE_READ_TIMEOUT_MS, null);
  }

  private async cacheVersion(): Promise<string> {
    const version = await withTimeout<string | null>(
      this.redis.getVersion(SEARCH_CACHE_VERSION_KEY),
      ListingsService.CACHE_READ_TIMEOUT_MS,
      null,
    );
    if (version === null) throw new Error('cache version lookup timed out');
    return version;
  }

  private searchDb(params: ListingSearchParams): Promise<LiveSearchResult> {
    return this.dbSearchSlots.run(() => withTransientRetry(() => this.queryLive(params)));
  }

  private async searchCacheKey(params: Record<string, unknown>): Promise<string> {
    const version = await this.cacheVersion();

    const sortedParams = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `listings:search:v${version}:${JSON.stringify(sortedParams)}`;
  }

  private applyFilters(
    qb: SelectQueryBuilder<ListingEntity>,
    params: ListingSearchParams,
    skip: { district?: boolean; tehsil?: boolean } = {},
  ): void {
    const text = buildTextCondition(params.q);
    if (text) qb.andWhere(text.sql, text.params);

    if (params.district && !skip.district) {
      qb.andWhere(`lower(${pd('district')}) = :district`, { district: params.district.toLowerCase() });
    }
    if (params.tehsil && !skip.tehsil) {
      qb.andWhere(`lower(${pd('tehsil')}) = :tehsil`, { tehsil: params.tehsil.toLowerCase() });
    }
    if (params.category) {

      qb.andWhere(`${PD}->'categories' @> :category::jsonb`, { category: JSON.stringify([params.category]) });
    }
    if (params.minGuests) {

      qb.andWhere(`COALESCE(NULLIF(${pd('maxGuests')}, ''), '2')::int >= :minGuests`, {
        minGuests: params.minGuests,
      });
    }

    if (params.pets) {

      qb.andWhere(`COALESCE(${pd('pets')}, 'false') = 'true'`);
    }

    if (params.moveIn) {

      qb.andWhere(`(${pd('availableFrom')})::date <= :moveIn`, { moveIn: params.moveIn });

      if (params.moveOut) {

        qb.andWhere(`(${pd('minDays')})::int <= (:moveOut::date - :moveIn::date)`, {
          moveIn: params.moveIn,
          moveOut: params.moveOut,
        });
      }

      qb.andWhere(
        `NOT EXISTS (
          SELECT 1 FROM bookings b
          WHERE b.listing_id = l.id
            AND b.status = ANY(:occupyingStatuses)
            AND b.move_in < :conflictEnd::date
            AND COALESCE(b.actual_move_out, b.move_out) > :conflictStart::date
        )`,
        {
          occupyingStatuses: ListingsService.OCCUPYING_BOOKING_STATUSES,
          conflictStart: params.moveIn,
          conflictEnd: params.moveOut ?? params.moveIn,
        },
      );
    }
  }

  private liveQuery(): SelectQueryBuilder<ListingEntity> {
    return this.listings.createQueryBuilder('l').where("l.status = 'live'");
  }

  private async queryLive(params: ListingSearchParams): Promise<LiveSearchResult> {
    const { page, pageSize } = clampPagination(params.page, params.pageSize);
    const countQb = this.liveQuery();
    this.applyFilters(countQb, params);
    const qb = this.liveQuery();
    this.applyFilters(qb, params);

    if (params.sortByTrust) {

      qb.orderBy("(l.draft_data->>'trustScore')::int", 'DESC', 'NULLS LAST')
        .addOrderBy('l.created_at', 'DESC')
        .addOrderBy('l.id', 'DESC');
    } else {
      qb.orderBy('l.created_at', 'DESC').addOrderBy('l.id', 'DESC');
    }

    const [total, rows, facets] = await Promise.all([
      countQb.getCount(),
      qb
        .skip((page - 1) * pageSize)
        .take(pageSize)
        .getMany(),
      params.facets ? this.queryFacets(params) : Promise.resolve(undefined),
    ]);

    const pageRows = rows.map((row) => ({ row, listing: rowToListing(row) }));

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

    const result: LiveSearchResult = { listings: filtered, total, page, pageSize };
    if (facets) result.facets = facets;
    return result;
  }

  private async queryFacets(params: ListingSearchParams): Promise<ListingFacets> {

    let cacheKey: string | null = null;
    if (!params.moveIn) {
      try {
        cacheKey = await this.facetsCacheKey(params);
        const cached = await this.cacheGet(cacheKey);
        if (cached) return JSON.parse(cached);
      } catch (err) {
        this.logger.warn(`listings facets cache read failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    const facets = await this.queryFacetsFromDb(params);

    if (cacheKey) {

      void this.redis.set(cacheKey, JSON.stringify(facets), ListingsService.FACETS_CACHE_TTL_SECONDS);
    }
    return facets;
  }

  private async facetsCacheKey(params: ListingSearchParams): Promise<string> {
    const version = await this.cacheVersion();
    const { q, district, tehsil, category, minGuests, pets } = params;
    return `listings:facets:v${version}:${JSON.stringify([q, district, tehsil, category, minGuests, pets])}`;
  }

  private async queryFacetsFromDb(params: ListingSearchParams): Promise<ListingFacets> {
    if (!params.district) {

      return this.queryCombinedFacets(params);
    }

    const districts = await this.queryDistrictFacet(params);
    const places = await this.queryPlaceFacet(params);
    return { districts, places };
  }

  private async queryCombinedFacets(params: ListingSearchParams): Promise<ListingFacets> {
    const qb = this.placeFacetQuery().addSelect(COVER_SQL, 'cover_url').addSelect(COVER_AT_SQL, 'cover_at');
    this.applyFilters(qb, params, { tehsil: true });
    const rows: (PlaceFacetRow & { cover_url: string | null; cover_at: Date | string | null })[] = await qb.getRawMany();

    const byName = new Map<string, DistrictFacet & { coverAt?: number }>();
    for (const r of rows) {
      if (r.district === '') continue;
      const name = canonicalDistrictName(r.district);
      const key = name.toLowerCase();
      const entry = byName.get(key) ?? { name, count: 0 };
      entry.count += Number(r.count);

      if (r.cover_url && r.cover_at) {
        const at = new Date(r.cover_at).getTime();
        if (entry.coverAt === undefined || at < entry.coverAt) {
          entry.coverAt = at;
          entry.coverUrl = r.cover_url;
        }
      }
      byName.set(key, entry);
    }
    const districts = [...byName.values()]
      .map(({ name, count, coverUrl }): DistrictFacet => (coverUrl ? { name, count, coverUrl } : { name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return { districts, places: this.foldPlaceRows(rows) };
  }

  private async queryDistrictFacet(params: ListingSearchParams): Promise<DistrictFacet[]> {
    const qb = this.liveQuery()
      .select(DISTRICT_SQL, 'district')
      .addSelect('COUNT(*)', 'count')
      .addSelect(COVER_SQL, 'cover_url')
      .groupBy(DISTRICT_SQL);
    this.applyFilters(qb, params, { district: true, tehsil: true });
    qb.andWhere(`${DISTRICT_SQL} <> ''`);

    const rows: { district: string; count: string; cover_url: string | null }[] = await qb.getRawMany();
    const byName = new Map<string, DistrictFacet>();
    for (const r of rows) {
      const name = canonicalDistrictName(r.district);
      const key = name.toLowerCase();
      const entry = byName.get(key) ?? { name, count: 0 };
      entry.count += Number(r.count);
      if (!entry.coverUrl && r.cover_url) entry.coverUrl = r.cover_url;
      byName.set(key, entry);
    }
    return [...byName.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  private placeFacetQuery(): SelectQueryBuilder<ListingEntity> {

    return this.liveQuery()
      .select(DISTRICT_SQL, 'district')
      .addSelect(PLACE_SQL, 'place')
      .addSelect('COUNT(*)', 'count')
      .addSelect(`(array_agg(${RATE_SQL} ORDER BY ${EFFECTIVE_SQL}) FILTER (WHERE ${RATE_SQL} > 0))[1]`, 'min_rate')
      .addSelect(`(array_agg(${DISC_SQL} ORDER BY ${EFFECTIVE_SQL}) FILTER (WHERE ${RATE_SQL} > 0))[1]`, 'min_disc')
      .groupBy(DISTRICT_SQL)
      .addGroupBy(PLACE_SQL);
  }

  private async queryPlaceFacet(params: ListingSearchParams): Promise<PlaceFacet[]> {
    const qb = this.placeFacetQuery();
    this.applyFilters(qb, params, { tehsil: true });
    const rows: PlaceFacetRow[] = await qb.getRawMany();
    return this.foldPlaceRows(rows);
  }

  private foldPlaceRows(rows: PlaceFacetRow[]): PlaceFacet[] {
    const groups = new Map<string, PlaceFacet>();
    for (const r of rows) {
      if (!r.place) continue;
      const district = r.district ? canonicalDistrictName(r.district) : '';
      const tehsil = canonicalTehsilName(district, r.place);
      const from =
        r.min_rate === null ? null : agreeTerms(Number(r.min_rate), 15, Number(r.min_disc ?? 40), 30).totalRent;

      const key = `${district.toLowerCase()}|${tehsil.toLowerCase()}`;
      const entry = groups.get(key);
      if (!entry) {
        groups.set(key, { district, tehsil, count: Number(r.count), fromMonthlyRent: from });
      } else {
        entry.count += Number(r.count);
        if (from !== null && (entry.fromMonthlyRent === null || from < entry.fromMonthlyRent)) {
          entry.fromMonthlyRent = from;
        }
      }
    }
    return [...groups.values()].sort(
      (a, b) => b.count - a.count || a.tehsil.localeCompare(b.tehsil) || a.district.localeCompare(b.district),
    );
  }

  async getTownSummaries(previewPerTown = 12): Promise<Town[]> {
    const cacheKey = await this.townSummariesCacheKey(previewPerTown);
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const result = await this.queryTownSummaries(previewPerTown);
    await this.redis.set(cacheKey, JSON.stringify(result), ListingsService.TOWN_SUMMARIES_CACHE_TTL_SECONDS);
    return result;
  }

  private async townSummariesCacheKey(previewPerTown: number): Promise<string> {
    const version = await this.redis.getVersion(SEARCH_CACHE_VERSION_KEY);
    return `listings:town_summaries:v2:${version}:${previewPerTown}`;
  }

  private async queryTownSummaries(previewPerTown: number): Promise<Town[]> {

    const places = await this.queryPlaceFacet({});
    const byName = new Map<string, Town>();
    for (const p of places) {
      const key = p.tehsil.toLowerCase();
      const town = byName.get(key);
      if (!town) {
        byName.set(key, { name: p.tehsil, from: p.fromMonthlyRent ?? 0, total: p.count, listings: [] });
      } else {
        town.total += p.count;
        if (p.fromMonthlyRent !== null && (town.from === 0 || p.fromMonthlyRent < town.from)) {
          town.from = p.fromMonthlyRent;
        }
      }
    }
    if (byName.size === 0) return [];

    const previewRows = await this.listings.query(
      `
      SELECT * FROM (
        SELECT l.*, lower(${PLACE_SQL}) AS place_key, ROW_NUMBER() OVER (
          PARTITION BY lower(${PLACE_SQL})
          ORDER BY l.created_at DESC, l.id DESC
        ) AS rn
        FROM listings l
        WHERE l.status = 'live'
          AND lower(${PLACE_SQL}) = ANY($1)
      ) ranked
      WHERE rn <= $2
      `,
      [[...byName.keys()], previewPerTown],
    );
    for (const row of previewRows) {
      byName.get(row.place_key)?.listings.push(rowToListing(row));
    }

    return [...byName.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }

  async findOnePublic(
    id: string,
    locale?: string,
    viewer?: { userId: string; isAdmin: boolean },
  ): Promise<{ listing: Listing; host: ListingHostInfo }> {
    const row = await this.listings.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Listing not found');
    }

    if (row.status !== 'live') {
      const isOwner = viewer?.userId === row.host_id;
      if (!viewer || (!isOwner && !viewer.isAdmin)) {
        throw new NotFoundException('Listing not found');
      }
    }

    const hostProfile = await this.profiles.findOne({ where: { id: row.host_id } });
    let listing = rowToListing(row);

    if (locale) {
      listing = await this.listingTranslations.getTranslatedListing(listing, row, locale);
    }

    listing = { ...listing, captureCheckPassed: captureCheckTrulyPassed((row.draft_data as Record<string, any>) ?? {}) };

    return {
      listing,
      host: {
        id: row.host_id,

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

  async getBookedRanges(listingId: string): Promise<{ moveIn: string; moveOut: string }[]> {
    const rows = await this.bookings.find({
      where: { listing_id: listingId, status: In(ListingsService.OCCUPYING_BOOKING_STATUSES) },
      select: { move_in: true, move_out: true, actual_move_out: true },
    });

    return rows
      .map((r) => ({ moveIn: r.move_in, moveOut: r.actual_move_out ?? r.move_out }))
      .filter((r) => r.moveOut > r.moveIn);
  }
}
