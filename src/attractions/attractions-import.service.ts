import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttractionEntity } from '../entities/attraction.entity';
import { GeocodeService } from '../listings/geocode.service';
import {
  HP_DISTRICTS,
  HP_LOCATIONS,
  isInsideHimachal,
  type HpDistrict,
} from '../listings/hp-locations';
import { AttractionImagesService } from './attraction-images.service';
import { AttractionsService } from './attractions.service';
import {
  DISTRICT_SEARCH_RADIUS_M,
  nearestDistrict,
  summarise,
  uniqueSlug,
} from './attraction.util';
import {
  fetchWikidataPlaces,
  summaryByTitle,
  type WikiPlace,
} from './wikidata-source';

/** Pause between Wikipedia/Commons lookups, polite to Wikimedia and still fast. */
const LOOKUP_GAP_MS = 150;
/** Pause between districts' Wikidata queries. */
const QUERY_GAP_MS = 1500;
const LOG_LINES = 80;

export type ImportOptions = {
  /** One district, or every district when omitted. */
  district?: HpDistrict;
};

export type ImportStatus = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  districts: string[];
  found: number;
  added: number;
  alreadyKnown: number;
  withPhoto: number;
  failed: number;
  log: string[];
  error: string | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pulls notable places for each district from Wikidata (places that have an
 * English Wikipedia article), adds the article's summary and an openly
 * licensed Commons photo where one exists, and saves each as a DRAFT for an
 * admin to review. Safe to re-run: a place already in the table (by Wikidata
 * id) is skipped before any lookups, so admin edits and hidden rows are never
 * overwritten.
 *
 * One run at a time per server process. Progress is kept in memory for the
 * admin console; it resets on restart, the imported rows do not.
 */
@Injectable()
export class AttractionsImportService {
  private readonly logger = new Logger(AttractionsImportService.name);
  private status: ImportStatus = {
    running: false,
    startedAt: null,
    finishedAt: null,
    districts: [],
    found: 0,
    added: 0,
    alreadyKnown: 0,
    withPhoto: 0,
    failed: 0,
    log: [],
    error: null,
  };

  constructor(
    @InjectRepository(AttractionEntity)
    private readonly repo: Repository<AttractionEntity>,
    private readonly images: AttractionImagesService,
    private readonly attractions: AttractionsService,
    private readonly geocode: GeocodeService,
  ) {}

  getStatus(): ImportStatus {
    return { ...this.status, log: [...this.status.log] };
  }

  /** Wikidata needs no key, so the import is always available. */
  isConfigured(): boolean {
    return true;
  }

  /** Starts a run in the background and returns at once. */
  start(options: ImportOptions = {}): ImportStatus {
    if (this.status.running)
      throw new ConflictException('An import is already running.');
    void this.run(options);
    return this.getStatus();
  }

  /** Runs to completion (used by the CLI and the scheduler). */
  async runNow(options: ImportOptions = {}): Promise<ImportStatus> {
    if (this.status.running)
      throw new ConflictException('An import is already running.');
    await this.run(options);
    return this.getStatus();
  }

  private note(line: string) {
    this.logger.log(line);
    this.status.log.push(`${new Date().toISOString().slice(11, 19)}  ${line}`);
    if (this.status.log.length > LOG_LINES)
      this.status.log.splice(0, this.status.log.length - LOG_LINES);
  }

  private async run(options: ImportOptions) {
    const districts: HpDistrict[] = options.district
      ? [options.district]
      : [...HP_DISTRICTS];
    this.status = {
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      districts,
      found: 0,
      added: 0,
      alreadyKnown: 0,
      withPhoto: 0,
      failed: 0,
      log: [],
      error: null,
    };
    this.note(
      `Import from Wikidata started for ${districts.length === 1 ? districts[0] : 'all 12 districts'}.`,
    );

    try {
      const known = new Set(
        (
          await this.repo.find({
            select: { source_id: true },
            where: { source: 'wikidata' },
          })
        )
          .map((r) => r.source_id)
          .filter((x): x is string => !!x),
      );
      const slugs = new Set(
        (await this.repo.find({ select: { slug: true } })).map((r) => r.slug),
      );

      for (const [i, district] of districts.entries()) {
        if (i > 0) await sleep(QUERY_GAP_MS);
        let places: WikiPlace[];
        try {
          const centre = HP_LOCATIONS[district].centre;
          places = (
            await fetchWikidataPlaces(
              centre.lat,
              centre.lng,
              DISTRICT_SEARCH_RADIUS_M[district] / 1000,
            )
          ).filter((p) => isInsideHimachal(p.lat, p.lng));
        } catch (err) {
          this.status.failed++;
          this.note(
            `${district}: Wikidata query failed (${(err as Error).message}). Try this district again later.`,
          );
          continue;
        }
        const fresh = places.filter((p) => !known.has(p.qid));
        this.status.found += places.length;
        this.status.alreadyKnown += places.length - fresh.length;
        this.note(
          `${district}: ${places.length} places found, ${fresh.length} new.`,
        );

        for (const place of fresh) {
          known.add(place.qid);
          try {
            // File the place under the district it actually lies in, which is not
            // always the one whose circle found it (circles overlap, and a district
            // centre is just its HQ town).
            const where = await this.locate(place);
            if (options.district && where.district !== options.district)
              continue;
            const added = await this.save(place, where, slugs);
            if (added) {
              this.status.added++;
              if (added.image_url) this.status.withPhoto++;
            }
          } catch (err) {
            this.status.failed++;
            this.note(`  ${place.name}: skipped (${(err as Error).message})`);
          }
          await sleep(LOOKUP_GAP_MS);
        }
      }
      if (this.status.added > 0) await this.attractions.invalidateCache();
      this.note(
        `Done. ${this.status.added} new drafts (${this.status.withPhoto} with a photo), ` +
          `${this.status.alreadyKnown} already known, ${this.status.failed} failed.`,
      );
    } catch (err) {
      this.status.error = (err as Error).message;
      this.note(`Import stopped: ${(err as Error).message}`);
    } finally {
      this.status.running = false;
      this.status.finishedAt = new Date().toISOString();
    }
  }

  /** The district (and tehsil) a point lies in, from the geocoder; the nearest district centre if it cannot say. */
  private async locate(
    place: WikiPlace,
  ): Promise<{ district: HpDistrict; tehsil: string | null }> {
    try {
      const { parts } = await this.geocode.reverse(place.lat, place.lng);
      if (parts.district)
        return { district: parts.district, tehsil: parts.tehsil ?? null };
    } catch {
      /* fall through to the nearest centre */
    }
    return { district: nearestDistrict(place.lat, place.lng), tehsil: null };
  }

  private async save(
    place: WikiPlace,
    where: { district: HpDistrict; tehsil: string | null },
    slugs: Set<string>,
  ): Promise<AttractionEntity | null> {
    const { district } = where;
    const slug = uniqueSlug(place.name, district, slugs);
    slugs.add(slug);

    // Description: the place's English Wikipedia article.
    const wiki = await summaryByTitle(place.articleTitle).catch(() => null);

    // Photo: the item's own Commons image, else the article's lead image when
    // it is hosted on Commons (only those carry license data we can check).
    let image: { url: string; credit: string } | null = null;
    if (place.commonsImage)
      image = await this.images.copyFromCommons(place.commonsImage, slug);
    if (!image && wiki?.imageUrl?.includes('/wikipedia/commons/')) {
      image = await this.images.copyFromCommons(wiki.imageUrl, slug);
    }

    const result = await this.repo
      .createQueryBuilder()
      .insert()
      .into(AttractionEntity)
      .values({
        slug,
        name: place.name,
        category: place.category,
        district,
        tehsil: where.tehsil,
        lat: place.lat,
        lng: place.lng,
        summary: summarise(wiki?.text),
        description: wiki?.text ?? null,
        image_url: image?.url ?? null,
        image_credit: image?.credit ?? null,
        popularity: Math.min(100, place.popularity + (image ? 10 : 0)),
        source: 'wikidata',
        source_id: place.qid,
        wikipedia_url: wiki?.url ?? null,
        status: 'draft',
      })
      .orIgnore()
      .returning('*')
      .execute();
    const row = (result.raw as AttractionEntity[])[0];
    if (row)
      this.note(
        `  + ${place.name} (${place.category})${image ? '' : ', no photo'}${wiki ? '' : ', no description'}`,
      );
    return row ?? null;
  }
}
