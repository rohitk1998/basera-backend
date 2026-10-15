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

/** `coverUrl` is the first photo of a live home in the district; absent when none has an uploaded photo. */
export type DistrictFacet = { name: string; count: number; coverUrl?: string };
/** `district` is '' for listings with no district; `tehsil` falls back to town/city. */
export type PlaceFacet = { district: string; tehsil: string; count: number; fromMonthlyRent: number | null };
export type ListingFacets = { districts: DistrictFacet[]; places: PlaceFacet[] };
export type LiveSearchResult = {
  listings: Listing[];
  total: number;
  page: number;
  pageSize: number;
  facets?: ListingFacets;
  /** Additive hints, present only when `q` was rewritten or is a nearby village. */
  searchedQuery?: string;
  resolvedQuery?: string;
  didYouMean?: string;
  /** True when `q` was rewritten by the fuzzy retry (not just a known spelling variant). */
  autoCorrected?: boolean;
  nearby?: { name: string; parent: string };
};

// The facet grouping expressions: the same trimmed fields the text search
// and the exact district/tehsil filters read, with a place named by its
// tehsil, else town, else city.
const DISTRICT_SQL = `COALESCE(trim(${pd('district')}), '')`;
const PLACE_SQL = `COALESCE(NULLIF(trim(${pd('tehsil')}), ''), NULLIF(trim(${pd('town')}), ''), NULLIF(trim(${pd('city')}), ''))`;

// Only a host-uploaded photo counts; the mapper's placeholder fallback is not stored.
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

// Shared with HostListingsService (whose resubmit() also pulls a row out of
// `live`, changing what public search returns) — kept as a top-level
// constant rather than a static on ListingsService so a sibling service can
// bump it without depending on ListingsService itself.
export const SEARCH_CACHE_VERSION_KEY = 'listings:search:version';

/**
 * Public browse/detail queries. Ported from web/app/api/listings/route.ts and
 * web/app/api/listings/[id]/route.ts. The mock-catalogue fallback in
 * lib/listings.server.ts is deliberately dropped here — this is a real
 * backend against a real database, so zero live listings means an empty
 * result, not fiction standing in for it.
 */
@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);

  // Bookings statuses that actually occupy a listing for their move_in/
  // COALESCE(actual_move_out, move_out) range. `requested` is excluded — an unconfirmed request holds
  // no dates yet, so it must not make an otherwise-free listing look
  // booked. `disputed` is included: the stay is still ongoing while a
  // dispute is open, whatever its outcome ends up being. `checked_out` is
  // the final state after `completed`, so it still holds those dates. `declined`,
  // `cancelled` and `expired` never occupied the listing at all.
  private static readonly OCCUPYING_BOOKING_STATUSES = [
    'confirmed',
    'checked_in',
    'disputed',
    'completed',
    'checked_out',
  ];

  // Short: this is a speed layer smoothing repeat requests within the same
  // few seconds of traffic (e.g. a browse page's initial load plus a few
  // filter tweaks), not a substitute for the version-bump invalidation
  // above — correctness comes from the version bump, the TTL is just a
  // backstop against a bump never happening for some untracked write path.
  private static readonly SEARCH_CACHE_TTL_SECONDS = 30;
  private static readonly TOWN_SUMMARIES_CACHE_TTL_SECONDS = 60;
  private readonly inFlightSearches = new Map<string, Promise<LiveSearchResult>>();
  private static readonly FACETS_CACHE_TTL_SECONDS = 60;
  // A hung Redis must cost a request ~300ms, not its 2.5s command timeout (x2 for version + value).
  private static readonly CACHE_READ_TIMEOUT_MS = 300;
  // At most 4 searches hit the DB at once per process (each can use up to 3 pool
  // connections); the rest queue, and a wait over 3s answers 503 + Retry-After.
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

  /** Called by every write path that can change what a public search or
   *  the town-summary/home-feed query returns (admin approving/rejecting a
   *  listing, a host resubmission that could change status) — see
   *  admin.service.ts reviewProperty() and host-listings.service.ts. */
  async bumpSearchCacheVersion(): Promise<void> {
    await this.redis.incrementVersion(SEARCH_CACHE_VERSION_KEY);
  }

  /**
   * The single public search: pushes status / q / district / tehsil /
   * category / guests / dates filtering into SQL against the jsonb draft_data
   * column and applies LIMIT/OFFSET at the DB level — a page of 48 out of
   * several thousand live listings only ever fetches and maps 48 rows.
   *
   * Pagination is always bounded (DEFAULT_PAGE_SIZE when omitted, at most
   * MAX_PAGE_SIZE, page >= 1). With `facets: true` the result also carries
   * per-district and per-place counts (see queryFacets). `params` is expected
   * to come from normalizeListingSearch(); only pagination is re-clamped here.
   */
  async findLive(params: ListingSearchParams): Promise<LiveSearchResult> {
    // Single-flight: identical searches arriving while one is running share its
    // result instead of each taking a pool connection (a page load fires the
    // same facets query from the server render, search bar and footer at once).
    const key = JSON.stringify(Object.entries(params).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
    const running = this.inFlightSearches.get(key);
    if (running) return running;
    const promise = this.findLiveWithHints(params).finally(() => this.inFlightSearches.delete(key));
    this.inFlightSearches.set(key, promise);
    return promise;
  }

  /**
   * Misspelling tolerance: a search that finds nothing is retried once with
   * `q` corrected against the places we know (districts, tehsils, tourist
   * names and the towns/localities of live listings). Only an empty result is
   * retried, so a query that already matches is never rewritten. A query that
   * is a nearby village ("bhagsu") also gets a `nearby` note.
   */
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

  /** Static places plus the town/locality/city/tehsil values of live listings, rebuilt at most once a minute. */
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

    // moveIn/moveOut searches depend on live booking state (the NOT EXISTS
    // overlap check below), which changes far more often than listing
    // content and isn't covered by bumpSearchCacheVersion() — caching those
    // would risk showing a listing as available after it's just been
    // booked. Every other search (the common case: browsing with no dates
    // picked yet) has no such freshness requirement beyond the version
    // bump + short TTL below, so only that path is cached.
    if (!normalized.moveIn) {
      // The cache is only ever an optimisation: any failure reading it (Redis
      // down, a corrupt value) falls through to the database query.
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
        // Not awaited (one remote round trip nothing depends on); RedisService.set never rejects.
        void this.redis.set(cacheKey, JSON.stringify(result), ListingsService.SEARCH_CACHE_TTL_SECONDS);
      }
      return result;
    }

    return this.searchDb(normalized);
  }

  /** Bounded Redis read: null (a miss) if it does not answer in time. */
  private cacheGet(key: string): Promise<string | null> {
    return withTimeout(this.redis.get(key), ListingsService.CACHE_READ_TIMEOUT_MS, null);
  }

  /** Cache version for a key; throws on timeout so the caller skips the cache
   *  entirely (a made-up version would also poison the write). */
  private async cacheVersion(): Promise<string> {
    const version = await withTimeout<string | null>(
      this.redis.getVersion(SEARCH_CACHE_VERSION_KEY),
      ListingsService.CACHE_READ_TIMEOUT_MS,
      null,
    );
    if (version === null) throw new Error('cache version lookup timed out');
    return version;
  }

  /** The DB half of a search: queued behind the concurrency limit, and the
   *  read-only queries retried once on a transient connection error. */
  private searchDb(params: ListingSearchParams): Promise<LiveSearchResult> {
    return this.dbSearchSlots.run(() => withTransientRetry(() => this.queryLive(params)));
  }

  private async searchCacheKey(params: Record<string, unknown>): Promise<string> {
    const version = await this.cacheVersion();
    // Stable across key order by sorting entries — params is always built
    // from the same fixed object shape at the call site, but this keeps the
    // key deterministic even if that ever changes. Every filter, the
    // pagination and the facets flag are part of the key.
    const sortedParams = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `listings:search:v${version}:${JSON.stringify(sortedParams)}`;
  }

  /**
   * Adds every active filter to `qb` (which must already be restricted to
   * live listings). `skip` leaves out the facet's own dimension: the
   * districts facet ignores district+tehsil, the places facet ignores tehsil.
   */
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
      // jsonb array membership — property_details.categories is a plain
      // JSON string array (see listing-schema.ts / listing-mapper.ts). The
      // mapper shows no categories for a listing that never stored any, so
      // such a listing correctly matches no category filter.
      qb.andWhere(`${PD}->'categories' @> :category::jsonb`, { category: JSON.stringify([params.category]) });
    }
    if (params.minGuests) {
      // The mapper shows 2 guests when none is stored; filter on the same.
      qb.andWhere(`COALESCE(NULLIF(${pd('maxGuests')}, ''), '2')::int >= :minGuests`, {
        minGuests: params.minGuests,
      });
    }

    if (params.pets) {
      // house_rules.pets is a required boolean (rulesSchema) and the mapper
      // shows "no pets" when none is stored; filter on the same.
      qb.andWhere(`COALESCE(${pd('pets')}, 'false') = 'true'`);
    }

    if (params.moveIn) {
      // Eligibility: the listing itself must already be postable by the
      // requested move-in date...
      // The parentheses matter: `::` binds tighter than `->>`, so without them
      // Postgres casts the key NAME ('availableFrom'::date) and every search
      // with dates fails with "invalid input syntax for type date".
      qb.andWhere(`(${pd('availableFrom')})::date <= :moveIn`, { moveIn: params.moveIn });

      if (params.moveOut) {
        // ...and long enough to cover the requested stay.
        qb.andWhere(`(${pd('minDays')})::int <= (:moveOut::date - :moveIn::date)`, {
          moveIn: params.moveIn,
          moveOut: params.moveOut,
        });
      }

      // Actual availability: exclude any listing with an occupying booking
      // whose [move_in, move_out) range overlaps the requested one. Two
      // ranges overlap iff each starts before the other ends — the
      // classic interval-overlap test, done directly in SQL against the
      // real bookings table rather than the listing's own single
      // "first ever free" date, which says nothing about a specific
      // already-booked stretch. A bare `moveIn` with no `moveOut` is
      // treated as a one-day request ([moveIn, moveIn]) for this check.
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

  /** A query builder over live listings. The literal 'live' (not a bind
   *  parameter) lets the planner use the partial indexes on live listings. */
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
      // NULLS LAST: a listing with no trustScore yet must sort below every
      // scored one (Postgres puts NULLs first on DESC). created_at/id keep
      // the order stable so pages don't reshuffle between requests.
      qb.orderBy("(l.draft_data->>'trustScore')::int", 'DESC', 'NULLS LAST')
        .addOrderBy('l.created_at', 'DESC')
        .addOrderBy('l.id', 'DESC');
    } else {
      qb.orderBy('l.created_at', 'DESC').addOrderBy('l.id', 'DESC');
    }

    // Count, page and facets are independent reads: issued together they cost
    // one database round trip of latency instead of three in a row (the
    // database is remote, so latency, not query time, is what a request pays).
    // That is at most 3 pooled connections per request: queryFacets runs its
    // own queries one after another when it needs more than one.
    const [total, rows, facets] = await Promise.all([
      countQb.getCount(),
      qb
        .skip((page - 1) * pageSize)
        .take(pageSize)
        .getMany(),
      params.facets ? this.queryFacets(params) : Promise.resolve(undefined),
    ]);

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

    const result: LiveSearchResult = { listings: filtered, total, page, pageSize };
    if (facets) result.facets = facets;
    return result;
  }

  /**
   * Counts over the live listings matching every active filter EXCEPT the
   * facet's own dimension, so picking a district in the UI doesn't make the
   * other districts vanish from the list of choices:
   *   - districts ignores `district` and `tehsil`;
   *   - places ignores `tehsil` but honours `district`.
   */
  private async queryFacets(params: ListingSearchParams): Promise<ListingFacets> {
    // Date searches depend on live booking state, which the version bump
    // doesn't cover (see findLive), so they are never cached.
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
    // Only a successful query is stored: a throw above never reaches here.
    if (cacheKey) {
      // Not awaited: the write costs a full round trip to a remote Redis and
      // nothing depends on it. RedisService.set resolves false on failure, never rejects.
      void this.redis.set(cacheKey, JSON.stringify(facets), ListingsService.FACETS_CACHE_TTL_SECONDS);
    }
    return facets;
  }

  /** Facets depend on the filters only, never on pagination or locale, so
   *  every page size / page / sort shares one entry. */
  private async facetsCacheKey(params: ListingSearchParams): Promise<string> {
    const version = await this.cacheVersion();
    const { q, district, tehsil, category, minGuests, pets } = params;
    return `listings:facets:v${version}:${JSON.stringify([q, district, tehsil, category, minGuests, pets])}`;
  }

  private async queryFacetsFromDb(params: ListingSearchParams): Promise<ListingFacets> {
    if (!params.district) {
      // Without a district filter both facets see the same listings (a tehsil
      // filter is skipped by both), so one scan grouped by district + place
      // yields both and the district counts are sums of the place groups.
      return this.queryCombinedFacets(params);
    }
    // With a district picked the districts facet must ignore it, the places
    // facet must not: two scans, run one after the other to stay within the
    // request's connection budget.
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
      // The earliest live listing with a photo across all of the district's groups.
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
    // Cheapest listing of each group by its effective per-day rate after its
    // own monthly discount; the figure itself is then produced by the shared
    // agreeTerms() in JS so it is exactly what the listing card shows.
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
      if (!r.place) continue; // no tehsil, town or city to name it by — still counted in `total`
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

  /**
   * @deprecated Per-town aggregate behind GET /api/listings/towns, kept only
   * so the Expo app (basera-app useTownListings) and old web builds keep
   * working. New callers use findLive({ facets: true }): the same counts and
   * "from" prices come from the places facet, the preview from the listings.
   *
   * Same response shape as before: one entry per place (tehsil, falling back
   * to town/city) with its true live count, cheapest monthly rent and a
   * bounded preview of mapped listings.
   */
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
    // The same places facet as GET /api/listings?facets=1 with no filters,
    // folded to one entry per place name (a tehsil name shared by two
    // districts is one "town" in this older, district-less shape).
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

    // One query for every place's preview rows instead of one query per
    // place: ROW_NUMBER() partitions live listings by place (newest first)
    // and the outer query keeps only the first `previewPerTown` of each.
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

    // Non-live listings (in_review, draft, rejected, ...) are excluded from
    // search, but a direct /stays/{id} hit must not leak them either — only
    // the listing's own host or an admin may view it before it's live.
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

  // Public: every occupying booking's [move_in, move_out) range for this
  // listing, so a guest's date picker can grey out/cross out dates that are
  // already taken before they attempt to book — same OCCUPYING_BOOKING_STATUSES
  // definition as the search overlap check above, so a range shown here is
  // exactly what would reject that booking attempt server-side.
  async getBookedRanges(listingId: string): Promise<{ moveIn: string; moveOut: string }[]> {
    const rows = await this.bookings.find({
      where: { listing_id: listingId, status: In(ListingsService.OCCUPYING_BOOKING_STATUSES) },
      select: { move_in: true, move_out: true, actual_move_out: true },
    });
    // A resolved early departure ends at actual_move_out — later nights are free.
    // A stay that ended on its first day occupies no nights, so it blocks nothing (and a
    // zero-night range could still grey out its start day in a calendar).
    return rows
      .map((r) => ({ moveIn: r.move_in, moveOut: r.actual_move_out ?? r.move_out }))
      .filter((r) => r.moveOut > r.moveIn);
  }
}
