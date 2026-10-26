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
const CACHE_TTL_SECONDS = 60 * 60 * 24;

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

  private async ensureSourceLocale(listing: Pick<Listing, 'title' | 'description'>, row: ListingEntity): Promise<string> {
    if (row.source_locale) return row.source_locale;

    const result = await this.provider.detect(listing.title || listing.description);
    const locale = result.status === 'ok' ? result.locale : DEFAULT_SOURCE_LOCALE;

    row.source_locale = locale;
    await this.listings.update({ id: row.id }, { source_locale: locale });
    return locale;
  }

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
          if (!row) return;
          results.set(listing.id, applyTranslation(listing, row));
          await this.redis.set(this.redisKey(listing.id, targetLocale, contentHash), JSON.stringify(row), CACHE_TTL_SECONDS);
        }),
      );
    }

    return results;
  }

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

  warmTranslation(listing: Listing, row: ListingEntity, targetLocale: string): void {
    this.getTranslatedListing(listing, row, targetLocale).catch(() => {});
  }

  async prewarmSourceLocale(row: ListingEntity): Promise<void> {
    if (row.source_locale) return;
    try {
      const listing = extractTitleAndDescriptionFromRow(row);
      await this.ensureSourceLocale(listing, row);
    } catch {
    }
  }
}

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
