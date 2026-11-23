import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository, SelectQueryBuilder } from 'typeorm';
import { ListingEntity, UserEntity, BookingEntity } from '../entities';
import { MIN_STAY_NIGHTS, agreeTerms } from '../common/domain';
import { discoveredToListing, rowToListing } from './listing-mapper';
import { discoveredGridSql } from '../discovery/discovered-predicate';
import { Listing, Town } from './listing.types';
import { HP_DISTRICTS, HP_LOCATIONS, tehsilsOf } from './hp-locations';
import { PLACE_ALIASES } from './place-aliases';
import { PlaceVocab, buildPlaceVocab, correctPlaceQuery, nearbyPlaceFor, spellingVariantFor } from './place-fuzzy';
import { ListingSearchParams, PD, buildDiscoveredTextCondition, buildTextCondition, clampPagination, pd } from './listing-search.util';
import { ListingTranslationService } from './listing-translation.service';
import { captureCheckTrulyPassed } from './capture-evidence.util';
import { RedisService } from '../redis/redis.service';
import { Semaphore, withTimeout, withTransientRetry } from './db-resilience';

export type ListingHostInfo = {
  id: string;
  name: string;
  avatarUrl?: string;
  joinedYear: number;
  trustScore: number | null;
  tier: null;
};

export type DistrictFacet = {
  name: string;
  count: number;
  coverUrl?: string | null;
  /** Present only when discovered stays are included. count = verifiedCount + discoveredCount. */
  verifiedCount?: number;
  discoveredCount?: number;
  fromMonthlyRent?: number | null;
};

export type PlaceFacet = {
  district: string;
  tehsil: string;
  count: number;
  fromMonthlyRent: number | null;
  verifiedCount?: number;
  discoveredCount?: number;
  coverUrl?: string | null;
};
export type ListingFacets = { districts: DistrictFacet[]; places: PlaceFacet[] };
export type LiveSearchResult = {
  listings: Listing[];
  total: number;
  /** Only when includeDiscovered. */
  ownerTotal?: number;
  discoveredTotal?: number;
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

/** Facet grouping when discovered rows are included: discovered rows use our own derived columns. */
const DISTRICT_SQL_ALL = `CASE WHEN l.is_discovered THEN COALESCE(trim(l.disc_district), '') ELSE ${DISTRICT_SQL} END`;
const PLACE_SQL_ALL = `CASE WHEN l.is_discovered THEN NULLIF(trim(l.disc_tehsil), '') ELSE ${PLACE_SQL} END`;

const COVER_PHOTO_SQL = `NULLIF(trim(${PD}->'photos'->0->>'url'), '')`;
const COVER_SQL = `(array_agg(${COVER_PHOTO_SQL} ORDER BY l.created_at, l.id) FILTER (WHERE ${COVER_PHOTO_SQL} IS NOT NULL))[1]`;
const COVER_AT_SQL = `MIN(l.created_at) FILTER (WHERE ${COVER_PHOTO_SQL} IS NOT NULL)`;
const COVER_SQL_ALL = `(array_agg(${COVER_PHOTO_SQL} ORDER BY l.created_at, l.id) FILTER (WHERE NOT l.is_discovered AND ${COVER_PHOTO_SQL} IS NOT NULL))[1]`;
const COVER_AT_SQL_ALL = `MIN(l.created_at) FILTER (WHERE NOT l.is_discovered AND ${COVER_PHOTO_SQL} IS NOT NULL)`;
const RATE_SQL = `NULLIF(${pd('dailyBaseRate')}, '')::numeric`;
const DISC_SQL = `COALESCE(NULLIF(${pd('monthlyDiscountPct')}, '')::numeric, 40)`;
const EFFECTIVE_SQL = `${RATE_SQL} * (1 - ${DISC_SQL} / 100)`;

type PlaceFacetRow = {
  district: string;
  place: string | null;
  count: string;
  min_rate: string | null;
  min_disc: string | null;
  verified_count?: string;
  cover_url?: string | null;
  cover_at?: Date | string | null;
};

type Cond = { sql: string; params?: Record<string, unknown> };
type FilterSkip = { district?: boolean; tehsil?: boolean };

function canonicalDistrictName(raw: string): string {
  const name = raw.trim();
  return HP_DISTRICTS.find((d) => d.toLowerCase() === name.toLowerCase()) ?? name;
}

function canonicalTehsilName(district: string, raw: string): string {
  const name = raw.trim();
  return tehsilsOf(district).find((t) => t.toLowerCase() === name.toLowerCase()) ?? name;
}

export const SEARCH_CACHE_VERSION_KEY = 'listings:search:version';

/** Daily rate as an int; NULL when absent or malformed so a legacy row never breaks the query. */
const PRICE_SQL = `(CASE WHEN ${pd('dailyBaseRate')} ~ '^[0-9]+$' THEN (${pd('dailyBaseRate')})::int END)`;

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

  async findLive(rawParams: ListingSearchParams): Promise<LiveSearchResult> {
    // hydrate never influences results, so it must not influence cache keys or coalescing.
    const { hydrate: _hydrate, ...params } = rawParams;
    void _hydrate;

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
    const sql = fields.map((f) => `SELECT DISTINCT trim(${pd(f)}) AS name FROM listings l WHERE l.status = 'live' AND l.is_discovered = false`).join(' UNION ');
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
      // keep default keys identical to the pre-flag ones
      includeDiscovered: params.includeDiscovered === true ? true : undefined,
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

  /** Phase 4 filters: price range, property type, bedrooms. ANDs onto the owner arm only. */
  private ownerExtraConds(params: ListingSearchParams): Cond[] {
    const c: Cond[] = [];
    if (params.minPrice !== undefined) c.push({ sql: `${PRICE_SQL} >= :minPrice`, params: { minPrice: params.minPrice } });
    if (params.maxPrice !== undefined) c.push({ sql: `${PRICE_SQL} <= :maxPrice`, params: { maxPrice: params.maxPrice } });
    if (params.propertyType) {
      c.push({ sql: `lower(${pd('propertyType')}) = :propertyType`, params: { propertyType: params.propertyType.toLowerCase() } });
    }
    if (params.bedrooms !== undefined) {
      c.push({
        sql: `(CASE WHEN ${pd('bedrooms')} ~ '^[0-9]+$' THEN (${pd('bedrooms')})::int END) >= :bedrooms`,
        params: { bedrooms: params.bedrooms },
      });
    }
    return c;
  }

  private applyConds(qb: { andWhere(sql: string, params?: Record<string, unknown>): unknown }, conds: Cond[]): void {
    for (const c of conds) qb.andWhere(c.sql, c.params);
  }

  private applyExtraFilters(qb: SelectQueryBuilder<ListingEntity>, params: ListingSearchParams): void {
    this.applyConds(qb, this.ownerExtraConds(params));
  }

  /** Owner-listing filters, unchanged from before discovered stays existed. */
  private ownerFilterConds(params: ListingSearchParams, skip: FilterSkip = {}): Cond[] {
    const c: Cond[] = [];
    const text = buildTextCondition(params.q);
    if (text) c.push({ sql: text.sql, params: text.params });

    if (params.district && !skip.district) {
      c.push({ sql: `lower(${pd('district')}) = :district`, params: { district: params.district.toLowerCase() } });
    }
    if (params.tehsil && !skip.tehsil) {
      c.push({ sql: `lower(${pd('tehsil')}) = :tehsil`, params: { tehsil: params.tehsil.toLowerCase() } });
    }
    if (params.category) {
      c.push({ sql: `${PD}->'categories' @> :category::jsonb`, params: { category: JSON.stringify([params.category]) } });
    }
    if (params.minGuests) {
      c.push({ sql: `COALESCE(NULLIF(${pd('maxGuests')}, ''), '2')::int >= :minGuests`, params: { minGuests: params.minGuests } });
    }
    if (params.pets) {
      c.push({ sql: `COALESCE(${pd('pets')}, 'false') = 'true'` });
    }
    if (params.moveIn) {
      c.push({ sql: `(${pd('availableFrom')})::date <= :moveIn`, params: { moveIn: params.moveIn } });
      if (params.moveOut) {
        c.push({
          sql: `GREATEST(${MIN_STAY_NIGHTS}, COALESCE((${pd('minDays')})::int, 0)) <= (:moveOut::date - :moveIn::date)`,
          params: { moveIn: params.moveIn, moveOut: params.moveOut },
        });
      }
      c.push({
        sql: `NOT EXISTS (
          SELECT 1 FROM bookings b
          WHERE b.listing_id = l.id
            AND b.status = ANY(:occupyingStatuses)
            AND b.move_in < :conflictEnd::date
            AND COALESCE(b.actual_move_out, b.move_out) > :conflictStart::date
        )`,
        params: {
          occupyingStatuses: ListingsService.OCCUPYING_BOOKING_STATUSES,
          conflictStart: params.moveIn,
          conflictEnd: params.moveOut ?? params.moveIn,
        },
      });
    }
    return c;
  }

  /**
   * Filters for the discovered arm. Returns null when a filter the discovered rows have no data
   * for is set (the arm is then omitted). `forFacets` ignores price, bedroom and property-type
   * filters, mirroring the owner facets which never applied them (and are cached without them).
   */
  private discoveredFilterConds(params: ListingSearchParams, skip: FilterSkip = {}, forFacets = false): Cond[] | null {
    const noData =
      params.category || params.minGuests || params.pets || params.moveIn || params.moveOut ||
      (!forFacets && (params.minPrice !== undefined || params.maxPrice !== undefined || params.bedrooms !== undefined || params.propertyType));
    if (noData) return null;

    const c: Cond[] = [];
    const text = buildDiscoveredTextCondition(params.q);
    if (text) c.push({ sql: text.sql, params: text.params });
    if (params.district && !skip.district) {
      c.push({ sql: 'lower(l.disc_district) = :d_district', params: { d_district: params.district.toLowerCase() } });
    }
    if (params.tehsil && !skip.tehsil) {
      c.push({ sql: 'lower(l.disc_tehsil) = :d_tehsil', params: { d_tehsil: params.tehsil.toLowerCase() } });
    }
    return c;
  }

  private applyFilters(qb: SelectQueryBuilder<ListingEntity>, params: ListingSearchParams, skip: FilterSkip = {}): void {
    this.applyConds(qb, this.ownerFilterConds(params, skip));
  }

  private liveQuery(includeDiscovered = false, params?: ListingSearchParams, skip: FilterSkip = {}, forFacets = false): SelectQueryBuilder<ListingEntity> {
    if (!includeDiscovered) {
      return this.listings.createQueryBuilder('l').where("l.status = 'live' AND l.is_discovered = false");
    }
    // The only path that admits discovered rows: an explicit second arm, narrowed by discoveredGridSql.
    const p = params ?? {};
    const owner = [...this.ownerFilterConds(p, skip), ...(forFacets ? [] : this.ownerExtraConds(p))];
    const disc = this.discoveredFilterConds(p, skip, forFacets);
    return this.listings.createQueryBuilder('l').where(
      new Brackets((w) => {
        w.where(
          new Brackets((o) => {
            o.where("l.status = 'live' AND l.is_discovered = false");
            this.applyConds(o, owner);
          }),
        );
        if (disc) {
          w.orWhere(
            new Brackets((d) => {
              d.where(discoveredGridSql('l'));
              this.applyConds(d, disc);
            }),
          );
        }
      }),
    );
  }

  private async queryLive(params: ListingSearchParams): Promise<LiveSearchResult> {
    const { page, pageSize } = clampPagination(params.page, params.pageSize);
    const withDisc = params.includeDiscovered === true;
    let countQb: SelectQueryBuilder<ListingEntity>;
    let qb: SelectQueryBuilder<ListingEntity>;
    if (withDisc) {
      countQb = this.liveQuery(true, params);
      qb = this.liveQuery(true, params);
    } else {
      countQb = this.liveQuery();
      this.applyFilters(countQb, params);
      this.applyExtraFilters(countQb, params);
      qb = this.liveQuery();
      this.applyFilters(qb, params);
      this.applyExtraFilters(qb, params);
    }

    // Owner-verified stays always rank first when discovered ones are included.
    const first = (kind: 'order' | 'add', expr: string, dir: 'ASC' | 'DESC', nulls?: 'NULLS LAST') => {
      if (kind === 'order') qb.orderBy(expr, dir, nulls);
      else qb.addOrderBy(expr, dir, nulls);
    };
    if (withDisc) qb.orderBy('l.is_discovered', 'ASC');
    const lead = withDisc ? 'add' : 'order';

    if (params.sort === 'price_asc' || params.sort === 'price_desc') {
      first(lead, `(${pd('dailyBaseRate')})::int`, params.sort === 'price_asc' ? 'ASC' : 'DESC', 'NULLS LAST');
      qb.addOrderBy('l.created_at', 'DESC').addOrderBy('l.id', 'DESC');
    } else if (params.sortByTrust || params.sort === 'trust') {
      first(lead, "(l.draft_data->>'trustScore')::int", 'DESC', 'NULLS LAST');
      qb.addOrderBy('l.created_at', 'DESC').addOrderBy('l.id', 'DESC');
    } else {
      first(lead, 'l.created_at', 'DESC');
      qb.addOrderBy('l.id', 'DESC');
    }

    const countPromise: Promise<{ total: number; ownerTotal?: number }> = withDisc
      ? countQb
          .select('count(*)::int', 'total')
          .addSelect('count(*) FILTER (WHERE NOT l.is_discovered)::int', 'owner_total')
          .getRawOne()
          .then((r: { total?: number | string; owner_total?: number | string } | undefined) => ({
            total: Number(r?.total ?? 0),
            ownerTotal: Number(r?.owner_total ?? 0),
          }))
      : countQb.getCount().then((total) => ({ total }));

    const [counts, rows, facets] = await Promise.all([
      countPromise,
      qb
        .skip((page - 1) * pageSize)
        .take(pageSize)
        .getMany(),
      params.facets ? this.queryFacets(params) : Promise.resolve(undefined),
    ]);
    const total = counts.total;

    const pageRows = rows.map((row) => ({
      row,
      discovered: row.is_discovered === true,
      listing: row.is_discovered ? discoveredToListing(row) : rowToListing(row),
    }));

    let filtered: Listing[];
    if (params.locale) {
      // Discovered stubs carry no translatable text; only owner rows go through translation.
      const ownerRows = pageRows.filter((r) => !r.discovered);
      const translated = await this.listingTranslations.getCachedTranslationsBatch(ownerRows, params.locale);
      filtered = pageRows.map(({ listing, row, discovered }) => {
        if (discovered) return listing;
        const hit = translated.get(listing.id);
        if (hit) return hit;
        this.listingTranslations.warmTranslation(listing, row, params.locale!);
        return listing;
      });
    } else {
      filtered = pageRows.map((r) => r.listing);
    }

    const result: LiveSearchResult = { listings: filtered, total, page, pageSize };
    if (withDisc) {
      result.ownerTotal = counts.ownerTotal ?? 0;
      result.discoveredTotal = total - result.ownerTotal;
    }
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
    const suffix = params.includeDiscovered === true ? ':d1' : '';
    return `listings:facets:v${version}:${JSON.stringify([q, district, tehsil, category, minGuests, pets])}${suffix}`;
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
    const withDisc = params.includeDiscovered === true;
    let qb: SelectQueryBuilder<ListingEntity>;
    if (withDisc) {
      qb = this.placeFacetQuery(true, params, { tehsil: true }).addSelect(COVER_SQL_ALL, 'cover_url').addSelect(COVER_AT_SQL_ALL, 'cover_at');
    } else {
      qb = this.placeFacetQuery().addSelect(COVER_SQL, 'cover_url').addSelect(COVER_AT_SQL, 'cover_at');
      this.applyFilters(qb, params, { tehsil: true });
    }
    const rows: PlaceFacetRow[] = await qb.getRawMany();

    type Entry = DistrictFacet & { coverAt?: number; verified: number; rate?: number };
    const byName = new Map<string, Entry>();
    for (const r of rows) {
      if (r.district === '') continue;
      const name = canonicalDistrictName(r.district);
      const key = name.toLowerCase();
      const entry = byName.get(key) ?? { name, count: 0, verified: 0 };
      entry.count += Number(r.count);
      entry.verified += Number(r.verified_count ?? 0);

      if (r.cover_url && r.cover_at) {
        const at = new Date(r.cover_at).getTime();
        if (entry.coverAt === undefined || at < entry.coverAt) {
          entry.coverAt = at;
          entry.coverUrl = r.cover_url;
        }
      }
      if (withDisc && r.min_rate !== null) {
        const from = agreeTerms(Number(r.min_rate), 15, Number(r.min_disc ?? 40), 30).totalRent;
        if (entry.rate === undefined || from < entry.rate) entry.rate = from;
      }
      byName.set(key, entry);
    }
    const districts = [...byName.values()]
      .map(({ name, count, coverUrl, verified, rate }): DistrictFacet =>
        withDisc
          ? { name, count, verifiedCount: verified, discoveredCount: count - verified, fromMonthlyRent: rate ?? null, coverUrl: coverUrl ?? null }
          : coverUrl
            ? { name, count, coverUrl }
            : { name, count },
      )
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return { districts, places: this.foldPlaceRows(rows, withDisc) };
  }

  private async queryDistrictFacet(params: ListingSearchParams): Promise<DistrictFacet[]> {
    const withDisc = params.includeDiscovered === true;
    const districtSql = withDisc ? DISTRICT_SQL_ALL : DISTRICT_SQL;
    const qb = this.liveQuery(withDisc, params, { district: true, tehsil: true }, true)
      .select(districtSql, 'district')
      .addSelect('COUNT(*)', 'count')
      .addSelect(withDisc ? COVER_SQL_ALL : COVER_SQL, 'cover_url')
      .groupBy(districtSql);
    if (withDisc) {
      qb.addSelect('count(*) FILTER (WHERE NOT l.is_discovered)', 'verified_count').addSelect(
        `(array_agg(${RATE_SQL} ORDER BY ${EFFECTIVE_SQL}) FILTER (WHERE ${RATE_SQL} > 0))[1]`,
        'min_rate',
      ).addSelect(`(array_agg(${DISC_SQL} ORDER BY ${EFFECTIVE_SQL}) FILTER (WHERE ${RATE_SQL} > 0))[1]`, 'min_disc');
    } else {
      this.applyFilters(qb, params, { district: true, tehsil: true });
    }
    qb.andWhere(`${districtSql} <> ''`);

    const rows: (PlaceFacetRow & { cover_url: string | null })[] = await qb.getRawMany();
    type Entry = DistrictFacet & { verified: number; rate?: number };
    const byName = new Map<string, Entry>();
    for (const r of rows) {
      const name = canonicalDistrictName(r.district);
      const key = name.toLowerCase();
      const entry = byName.get(key) ?? { name, count: 0, verified: 0 };
      entry.count += Number(r.count);
      entry.verified += Number(r.verified_count ?? 0);
      if (!entry.coverUrl && r.cover_url) entry.coverUrl = r.cover_url;
      if (withDisc && r.min_rate !== null && r.min_rate !== undefined) {
        const from = agreeTerms(Number(r.min_rate), 15, Number(r.min_disc ?? 40), 30).totalRent;
        if (entry.rate === undefined || from < entry.rate) entry.rate = from;
      }
      byName.set(key, entry);
    }
    return [...byName.values()]
      .map(({ verified, rate, ...d }): DistrictFacet =>
        withDisc
          ? { ...d, coverUrl: d.coverUrl ?? null, verifiedCount: verified, discoveredCount: d.count - verified, fromMonthlyRent: rate ?? null }
          : d,
      )
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  private placeFacetQuery(includeDiscovered = false, params?: ListingSearchParams, skip: FilterSkip = {}): SelectQueryBuilder<ListingEntity> {
    if (!includeDiscovered) {
      return this.liveQuery()
        .select(DISTRICT_SQL, 'district')
        .addSelect(PLACE_SQL, 'place')
        .addSelect('COUNT(*)', 'count')
        .addSelect(`(array_agg(${RATE_SQL} ORDER BY ${EFFECTIVE_SQL}) FILTER (WHERE ${RATE_SQL} > 0))[1]`, 'min_rate')
        .addSelect(`(array_agg(${DISC_SQL} ORDER BY ${EFFECTIVE_SQL}) FILTER (WHERE ${RATE_SQL} > 0))[1]`, 'min_disc')
        .groupBy(DISTRICT_SQL)
        .addGroupBy(PLACE_SQL);
    }
    return this.liveQuery(true, params, skip, true)
      .select(DISTRICT_SQL_ALL, 'district')
      .addSelect(PLACE_SQL_ALL, 'place')
      .addSelect('COUNT(*)', 'count')
      .addSelect('count(*) FILTER (WHERE NOT l.is_discovered)', 'verified_count')
      .addSelect(`(array_agg(${RATE_SQL} ORDER BY ${EFFECTIVE_SQL}) FILTER (WHERE ${RATE_SQL} > 0))[1]`, 'min_rate')
      .addSelect(`(array_agg(${DISC_SQL} ORDER BY ${EFFECTIVE_SQL}) FILTER (WHERE ${RATE_SQL} > 0))[1]`, 'min_disc')
      .groupBy(DISTRICT_SQL_ALL)
      .addGroupBy(PLACE_SQL_ALL);
  }

  private async queryPlaceFacet(params: ListingSearchParams): Promise<PlaceFacet[]> {
    const withDisc = params.includeDiscovered === true;
    const qb = this.placeFacetQuery(withDisc, params, { tehsil: true });
    if (withDisc) {
      qb.addSelect(COVER_SQL_ALL, 'cover_url').addSelect(COVER_AT_SQL_ALL, 'cover_at');
    } else {
      this.applyFilters(qb, params, { tehsil: true });
    }
    const rows: PlaceFacetRow[] = await qb.getRawMany();
    return this.foldPlaceRows(rows, withDisc);
  }

  private foldPlaceRows(rows: PlaceFacetRow[], withDisc = false): PlaceFacet[] {
    type Entry = PlaceFacet & { verified: number; coverAt?: number };
    const groups = new Map<string, Entry>();
    for (const r of rows) {
      if (!r.place) continue;
      const district = r.district ? canonicalDistrictName(r.district) : '';
      const tehsil = canonicalTehsilName(district, r.place);
      const from =
        r.min_rate === null ? null : agreeTerms(Number(r.min_rate), 15, Number(r.min_disc ?? 40), 30).totalRent;
      const verified = Number(r.verified_count ?? 0);
      const at = r.cover_url && r.cover_at ? new Date(r.cover_at).getTime() : undefined;

      const key = `${district.toLowerCase()}|${tehsil.toLowerCase()}`;
      const entry = groups.get(key);
      if (!entry) {
        groups.set(key, {
          district,
          tehsil,
          count: Number(r.count),
          fromMonthlyRent: from,
          verified,
          coverUrl: at !== undefined ? r.cover_url : null,
          coverAt: at,
        });
      } else {
        entry.count += Number(r.count);
        entry.verified += verified;
        if (from !== null && (entry.fromMonthlyRent === null || from < entry.fromMonthlyRent)) {
          entry.fromMonthlyRent = from;
        }
        if (at !== undefined && (entry.coverAt === undefined || at < entry.coverAt)) {
          entry.coverAt = at;
          entry.coverUrl = r.cover_url;
        }
      }
    }
    return [...groups.values()]
      .map(({ verified, coverAt: _c, coverUrl, ...p }): PlaceFacet =>
        withDisc ? { ...p, verifiedCount: verified, discoveredCount: p.count - verified, coverUrl: coverUrl ?? null } : p,
      )
      .sort((a, b) => b.count - a.count || a.tehsil.localeCompare(b.tehsil) || a.district.localeCompare(b.district));
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
          AND l.is_discovered = false
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

    // Discovered (unclaimed) rows have no owner: only an admin may ever see one.
    if (row.is_discovered && !viewer?.isAdmin) {
      throw new NotFoundException('Listing not found');
    }
    if (row.status !== 'live') {
      const isOwner = !row.is_discovered && !!row.host_id && viewer?.userId === row.host_id;
      if (!viewer || (!isOwner && !viewer.isAdmin)) {
        throw new NotFoundException('Listing not found');
      }
    }

    const hostProfile = await row.host_id ? await this.profiles.findOne({ where: { id: row.host_id } }) : null;
    let listing = rowToListing(row);

    if (locale) {
      listing = await this.listingTranslations.getTranslatedListing(listing, row, locale);
    }

    listing = { ...listing, captureCheckPassed: captureCheckTrulyPassed((row.draft_data as Record<string, any>) ?? {}) };
    // An admin can fetch an unclaimed row, but it is an empty stub (no title, photos or price). Flag it so the guest-facing
    // stay page falls back to the discovered view instead of rendering mock defaults.
    if (row.is_discovered) listing = { ...listing, discovered: true };

    return {
      listing,
      host: {
        id: row.host_id ?? '',

        name: hostProfile?.full_name || 'Host',
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
