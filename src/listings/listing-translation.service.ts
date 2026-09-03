import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ListingEntity, ListingTranslationEntity } from '../entities';
import { RedisService } from '../redis/redis.service';
import type { Listing } from './listing.types';
import { extractTranslatableFields, hashTranslatableContent } from './listing-translation.util';
import type { TranslateProvider } from './providers/translate-provider.interface';
import { TRANSLATE_PROVIDER } from './providers/translate-provider.token';

const DEFAULT_SOURCE_LOCALE = 'en';
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 1 day — Redis is a speed layer over
// Postgres (the durable store), so a value falling out of Redis just means
// the next read re-populates it from the DB, not a lost translation.

/**
 * Cache-aside translation of a listing's free-text fields. First request
 * for a given (listing, locale, content) triggers a translation call and
 * stores the result; every later request for the same triple is a cache
 * read. A host edit changes the content hash, so it never serves a stale
 * translation — the old row just stops matching.
 *
 * Two cache layers in front of the translation provider: Redis (fast,
 * shared across processes, may evict) backed by the listing_translations
 * table (durable — a translation already paid for is never re-bought just
 * because Redis evicted it).
 */
@Injectable()
export class ListingTranslationService {
  constructor(
    @InjectRepository(ListingEntity)
    private readonly listings: Repository<ListingEntity>,
    @InjectRepository(ListingTranslationEntity)
    private readonly translations: Repository<ListingTranslationEntity>,
    @Inject(TRANSLATE_PROVIDER)
    private readonly provider: TranslateProvider,
    private readonly redis: RedisService,
  ) {}

  private redisKey(listingId: string, locale: string, contentHash: string): string {
    return `listing_translation:${listingId}:${locale}:${contentHash}`;
  }

  /** Detects and persists source_locale once per listing row if unset, and
   *  keeps the caller's in-memory `row` in sync so a second call in the
   *  same request (or the same row object reused across items) doesn't
   *  re-detect. Cheap no-op on every call after the first. */
  private async ensureSourceLocale(listing: Pick<Listing, 'title' | 'description'>, row: ListingEntity): Promise<string> {
    if (row.source_locale) return row.source_locale;

    const result = await this.provider.detect(listing.title || listing.description);
    const locale = result.status === 'ok' ? result.locale : DEFAULT_SOURCE_LOCALE;

    row.source_locale = locale;
    await this.listings.update({ id: row.id }, { source_locale: locale });
    return locale;
  }

  /** Cache check that still detects source_locale (a cheap, cached-after-
   *  first-call operation — see ensureSourceLocale) but never calls the
   *  translation provider itself. Returns null on a cache miss so the
   *  caller (e.g. the list endpoint) can serve the original listing
   *  immediately and warm the cache in the background instead of blocking
   *  the response on a live translation call. Without detecting source
   *  locale here, a listing whose language was never detected would wrongly
   *  fall back to 'en' and get needlessly (mis-)translated on every list
   *  request until its detail page happened to be visited once. */
  async getCachedTranslation(listing: Listing, row: ListingEntity, targetLocale: string): Promise<Listing | null> {
    const sourceLocale = await this.ensureSourceLocale(listing, row);
    if (targetLocale === sourceLocale) return listing;

    const contentHash = hashTranslatableContent(listing);

    const redisHit = await this.redis.get(this.redisKey(listing.id, targetLocale, contentHash));
    if (redisHit) return applyTranslation(listing, JSON.parse(redisHit));

    const cached = await this.translations.findOne({
      where: { listing_id: listing.id, locale: targetLocale, content_hash: contentHash },
    });
    if (!cached) return null;

    await this.redis.set(this.redisKey(listing.id, targetLocale, contentHash), JSON.stringify(cached), CACHE_TTL_SECONDS);
    return applyTranslation(listing, cached);
  }

  /** Same as getCachedTranslation but for many listings at once — a single
   *  batched DB query (`listing_id IN (...)`) instead of one query per
   *  listing, which is what the list endpoint needs to avoid N+1 queries
   *  on every browse-page request. Redis is still checked per-item first
   *  (a pipeline would save round-trips further, but the DB fallback here
   *  is already a single query, so the win is smaller than for the DB
   *  path — left as a follow-up if Redis round-trip latency shows up in
   *  practice). */
  async getCachedTranslationsBatch(
    items: { listing: Listing; row: ListingEntity }[],
    targetLocale: string,
  ): Promise<Map<string, Listing>> {
    const results = new Map<string, Listing>();
    const dbLookupNeeded: { listing: Listing; contentHash: string }[] = [];

    await Promise.all(
      items.map(async ({ listing, row }) => {
        const sourceLocale = await this.ensureSourceLocale(listing, row);
        if (targetLocale === sourceLocale) {
          results.set(listing.id, listing);
          return;
        }

        const contentHash = hashTranslatableContent(listing);
        const redisHit = await this.redis.get(this.redisKey(listing.id, targetLocale, contentHash));
        if (redisHit) {
          results.set(listing.id, applyTranslation(listing, JSON.parse(redisHit)));
          return;
        }

        dbLookupNeeded.push({ listing, contentHash });
      }),
    );

    if (dbLookupNeeded.length > 0) {
      const rows = await this.translations.find({
        where: { listing_id: In(dbLookupNeeded.map((d) => d.listing.id)), locale: targetLocale },
      });
      const byListingAndHash = new Map(rows.map((r) => [`${r.listing_id}:${r.content_hash}`, r]));

      await Promise.all(
        dbLookupNeeded.map(async ({ listing, contentHash }) => {
          const row = byListingAndHash.get(`${listing.id}:${contentHash}`);
          if (!row) return; // still a miss — caller warms it in the background
          results.set(listing.id, applyTranslation(listing, row));
          await this.redis.set(this.redisKey(listing.id, targetLocale, contentHash), JSON.stringify(row), CACHE_TTL_SECONDS);
        }),
      );
    }

    return results;
  }

  /** Translates on cache miss, serves from cache on hit. Returns the
   *  original listing unchanged if targetLocale matches the source, if the
   *  provider is unconfigured, or if translation fails — never blocks or
   *  throws on a translation problem. */
  async getTranslatedListing(listing: Listing, row: ListingEntity, targetLocale: string): Promise<Listing> {
    const sourceLocale = await this.ensureSourceLocale(listing, row);
    if (targetLocale === sourceLocale) return listing;

    const contentHash = hashTranslatableContent(listing);

    const redisHit = await this.redis.get(this.redisKey(listing.id, targetLocale, contentHash));
    if (redisHit) return applyTranslation(listing, JSON.parse(redisHit));

    const cached = await this.translations.findOne({
      where: { listing_id: listing.id, locale: targetLocale, content_hash: contentHash },
    });
    if (cached) {
      await this.redis.set(this.redisKey(listing.id, targetLocale, contentHash), JSON.stringify(cached), CACHE_TTL_SECONDS);
      return applyTranslation(listing, cached);
    }

    const fields = extractTranslatableFields(listing);
    const result = await this.provider.translate(fields, sourceLocale, targetLocale);
    if (result.status !== 'ok') return listing;

    // A provider that returns a different-length amenity array would zip
    // translated labels onto the wrong amenity id/group below — treat that
    // as a failed translation rather than silently caching a mismatch.
    if (result.fields.amenityLabels.length !== listing.amenities.length) return listing;

    const saved = await this.translations.save(
      this.translations.create({
        listing_id: listing.id,
        locale: targetLocale,
        content_hash: contentHash,
        source_locale: sourceLocale,
        title: result.fields.title,
        description: result.fields.description,
        the_space: result.fields.theSpace,
        guest_access: result.fields.guestAccess,
        amenities: listing.amenities.map((a, i) => ({ ...a, label: result.fields.amenityLabels[i] ?? a.label })),
        house_rules_check_in: result.fields.houseRulesCheckIn,
        house_rules_check_out: result.fields.houseRulesCheckOut,
      }),
    );

    await this.redis.set(this.redisKey(listing.id, targetLocale, contentHash), JSON.stringify(saved), CACHE_TTL_SECONDS);
    return applyTranslation(listing, saved);
  }

  /** Fire-and-forget cache fill — used by the list endpoint so a cache miss
   *  never blocks the response; errors are swallowed since there is no
   *  caller waiting on the result. */
  warmTranslation(listing: Listing, row: ListingEntity, targetLocale: string): void {
    this.getTranslatedListing(listing, row, targetLocale).catch(() => {});
  }

  /** Called once at listing publish time (status -> 'live') to detect and
   *  persist source_locale ahead of the first guest request, so the first
   *  real reader never pays the detection latency or triggers a write on
   *  the read path. Safe no-op if already set. Never throws — publish must
   *  never fail because of a translation-detection hiccup. */
  async prewarmSourceLocale(row: ListingEntity): Promise<void> {
    if (row.source_locale) return;
    try {
      const listing = extractTitleAndDescriptionFromRow(row);
      await this.ensureSourceLocale(listing, row);
    } catch {
      // best-effort — first real request will retry detection
    }
  }
}

// Minimal shape ensureSourceLocale actually reads (title/description) —
// avoids importing rowToListing here just for two fields at publish time.
function extractTitleAndDescriptionFromRow(row: ListingEntity): Pick<Listing, 'title' | 'description'> {
  const draft = (row.draft_data as Record<string, any>) || {};
  const propStep = draft.property_details || draft.property || draft.basics || {};
  return {
    title: propStep.title || '',
    description: propStep.description || '',
  };
}

function applyTranslation(listing: Listing, t: ListingTranslationEntity): Listing {
  return {
    ...listing,
    title: t.title ?? listing.title,
    description: t.description ?? listing.description,
    theSpace: t.the_space ?? listing.theSpace,
    guestAccess: t.guest_access ?? listing.guestAccess,
    amenities: t.amenities ?? listing.amenities,
    houseRules: {
      ...listing.houseRules,
      checkIn: t.house_rules_check_in ?? listing.houseRules.checkIn,
      checkOut: t.house_rules_check_out ?? listing.houseRules.checkOut,
    },
  };
}
