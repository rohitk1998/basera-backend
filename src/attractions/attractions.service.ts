import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttractionEntity } from '../entities/attraction.entity';
import {
  ATTRACTION_CATEGORIES,
  ATTRACTION_STATUSES,
  type AttractionCategory,
  type AttractionStatus,
} from './attraction.types';
import { HP_DISTRICTS, type HpDistrict } from '../listings/hp-locations';
import { RedisService } from '../redis/redis.service';
import { AttractionImagesService } from './attraction-images.service';
import {
  attractionInputSchema,
  attractionUpdateSchema,
  resolveDistrict,
  slugify,
  summarise,
  toPublicAttraction,
  uniqueSlug,
  type AttractionUpdate,
  type PublicAttraction,
} from './attraction.util';
import { searchYoutube, type YoutubeVideo } from './external-sources';

const CACHE_VERSION_KEY = 'attractions:version';
const CACHE_TTL_SECONDS = 60 * 60;
const MAX_PUBLIC_LIMIT = 120;

export type CategoryCounts = Record<'all' | AttractionCategory, number>;

export type DistrictAttractions = {
  district: HpDistrict | null;
  counts: CategoryCounts;
  attractions: PublicAttraction[];
};

function emptyCounts(): CategoryCounts {
  return Object.fromEntries([
    ['all', 0],
    ...ATTRACTION_CATEGORIES.map((c) => [c, 0]),
  ]) as CategoryCounts;
}

function firstIssue(error: {
  issues: Array<{ message: string; path: PropertyKey[] }>;
}): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid attraction';
  const field = issue.path.map(String).join('.');
  return field ? `${field}: ${issue.message}` : issue.message;
}

@Injectable()
export class AttractionsService {
  constructor(
    @InjectRepository(AttractionEntity)
    private readonly repo: Repository<AttractionEntity>,
    private readonly redis: RedisService,
    private readonly images: AttractionImagesService,
    private readonly config: ConfigService,
  ) {}

  // ------------------------------------------------------------- public

  /**
   * Published attractions for the district a /stays search is about. Takes
   * the same params as the listings search (district / tehsil / q). A search
   * that is not about one district, or a bad param, is an empty answer — this
   * never 4xx/5xx's for input, so the search page can always render.
   */
  async forSearch(
    query: Record<string, unknown>,
  ): Promise<DistrictAttractions> {
    const district = resolveDistrict(query);
    if (!district)
      return { district: null, counts: emptyCounts(), attractions: [] };

    const rawLimit = Number(
      Array.isArray(query.limit) ? query.limit[0] : query.limit,
    );
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), MAX_PUBLIC_LIMIT)
        : MAX_PUBLIC_LIMIT;

    const version = await this.redis.getVersion(CACHE_VERSION_KEY);
    const key = `attractions:v${version}:${district}:${limit}`;
    const cached = await this.redis.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as DistrictAttractions;
      } catch {
        /* fall through to the database */
      }
    }

    const rows = await this.repo.find({
      where: { district, status: 'published' },
      order: { popularity: 'DESC', name: 'ASC' },
      take: limit,
    });
    const counts = emptyCounts();
    const countRows = await this.repo
      .createQueryBuilder('a')
      .select('a.category', 'category')
      .addSelect('count(*)::int', 'n')
      .where('a.district = :district and a.status = :status', {
        district,
        status: 'published',
      })
      .groupBy('a.category')
      .getRawMany<{ category: AttractionCategory; n: number }>();
    for (const r of countRows) {
      counts[r.category] = Number(r.n);
      counts.all += Number(r.n);
    }

    const result: DistrictAttractions = {
      district,
      counts,
      attractions: rows.map(toPublicAttraction),
    };
    await this.redis.set(key, JSON.stringify(result), CACHE_TTL_SECONDS);
    return result;
  }

  /** Drops every cached district answer at once (a generation bump, no key scan). */
  async invalidateCache(): Promise<void> {
    await this.redis.incrementVersion(CACHE_VERSION_KEY);
  }

  // -------------------------------------------------------------- admin

  async adminList(query: Record<string, unknown>) {
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const district = text(query.district);
    const category = text(query.category);
    const status = text(query.status);
    const search = text(query.search).slice(0, 80);

    const qb = this.repo.createQueryBuilder('a');
    if ((HP_DISTRICTS as readonly string[]).includes(district))
      qb.andWhere('a.district = :district', { district });
    if ((ATTRACTION_CATEGORIES as readonly string[]).includes(category))
      qb.andWhere('a.category = :category', { category });
    if ((ATTRACTION_STATUSES as readonly string[]).includes(status))
      qb.andWhere('a.status = :status', { status });
    if (search)
      qb.andWhere('a.name ilike :search', {
        search: `%${search.replace(/[%_\\]/g, '\\$&')}%`,
      });
    qb.orderBy('a.district', 'ASC')
      .addOrderBy('a.popularity', 'DESC')
      .addOrderBy('a.name', 'ASC')
      .take(500);

    const rows = await qb.getMany();
    const statusRows = await this.repo
      .createQueryBuilder('a')
      .select('a.status', 'status')
      .addSelect('count(*)::int', 'n')
      .groupBy('a.status')
      .getRawMany<{ status: AttractionStatus; n: number }>();
    const counts: Record<AttractionStatus, number> = {
      draft: 0,
      published: 0,
      hidden: 0,
    };
    for (const r of statusRows) counts[r.status] = Number(r.n);

    return { attractions: rows.map((a) => this.toAdmin(a)), counts };
  }

  async create(body: unknown) {
    const parsed = attractionInputSchema.safeParse(body ?? {});
    if (!parsed.success)
      throw new BadRequestException(firstIssue(parsed.error));
    const input = parsed.data;

    const taken = new Set(
      (
        await this.repo
          .createQueryBuilder('a')
          .select('a.slug', 'slug')
          .where('a.slug like :p', { p: `${slugify(input.name)}%` })
          .getRawMany<{ slug: string }>()
      ).map((r) => r.slug),
    );
    const slug = uniqueSlug(input.name, input.district, taken);

    const entity = this.repo.create({
      slug,
      name: input.name,
      category: input.category,
      district: input.district,
      tehsil: input.tehsil ?? null,
      lat: input.lat,
      lng: input.lng,
      summary: input.summary ?? summarise(input.description),
      description: input.description ?? null,
      difficulty: input.difficulty ?? null,
      duration: input.duration ?? null,
      distance_km: input.distanceKm ?? null,
      best_season: input.bestSeason ?? null,
      youtube_ids: input.youtubeIds ?? [],
      popularity: input.popularity ?? 50,
      status: input.status ?? 'draft',
      source: 'manual',
      source_id: null,
    });

    let imageWarning: string | undefined;
    if (input.commonsImage) {
      const image = await this.images.copyFromCommons(input.commonsImage, slug);
      if (image) {
        entity.image_url = image.url;
        entity.image_credit = image.credit;
      } else {
        imageWarning =
          'Saved without a photo: that Commons file could not be used.';
      }
    }

    const saved = await this.repo.save(entity);
    await this.invalidateCache();
    return { attraction: this.toAdmin(saved), imageWarning };
  }

  async update(id: string, body: unknown) {
    const parsed = attractionUpdateSchema.safeParse(body ?? {});
    if (!parsed.success)
      throw new BadRequestException(firstIssue(parsed.error));
    const input: AttractionUpdate = parsed.data;

    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Attraction not found');

    if (input.name !== undefined) row.name = input.name;
    if (input.category !== undefined) row.category = input.category;
    if (input.district !== undefined) row.district = input.district;
    if (input.tehsil !== undefined) row.tehsil = input.tehsil ?? null;
    if (input.lat !== undefined) row.lat = input.lat;
    if (input.lng !== undefined) row.lng = input.lng;
    if (input.summary !== undefined) row.summary = input.summary ?? null;
    if (input.description !== undefined)
      row.description = input.description ?? null;
    if (input.difficulty !== undefined)
      row.difficulty = input.difficulty ?? null;
    if (input.duration !== undefined) row.duration = input.duration ?? null;
    if (input.distanceKm !== undefined)
      row.distance_km = input.distanceKm ?? null;
    if (input.bestSeason !== undefined)
      row.best_season = input.bestSeason ?? null;
    if (input.youtubeIds !== undefined) row.youtube_ids = input.youtubeIds;
    if (input.popularity !== undefined) row.popularity = input.popularity;
    if (input.status !== undefined) row.status = input.status;

    let imageWarning: string | undefined;
    if (input.commonsImage) {
      const image = await this.images.copyFromCommons(
        input.commonsImage,
        row.slug,
      );
      if (image) {
        row.image_url = image.url;
        row.image_credit = image.credit;
      } else {
        imageWarning =
          'The photo was not changed: that Commons file could not be used.';
      }
    }

    row.updated_at = new Date();
    const saved = await this.repo.save(row);
    await this.invalidateCache();
    return { attraction: this.toAdmin(saved), imageWarning };
  }

  async remove(id: string) {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Attraction not found');
    if (row.source !== 'manual') {
      // Deleting an imported row would let the next import bring it back as
      // a fresh draft. Hiding it keeps it out for good.
      throw new BadRequestException(
        'Imported places cannot be deleted. Hide it instead, so the next import does not add it again.',
      );
    }
    await this.repo.delete(id);
    await this.invalidateCache();
    return { id };
  }

  async youtubeSearch(q: unknown): Promise<YoutubeVideo[]> {
    const text = typeof q === 'string' ? q.trim().slice(0, 100) : '';
    if (text.length < 2)
      throw new BadRequestException(
        'Type at least 2 characters to search YouTube.',
      );
    const key = this.config.get<string>('YOUTUBE_API_KEY');
    if (!key)
      throw new ServiceUnavailableException(
        'YouTube search is not set up: add YOUTUBE_API_KEY to the backend .env.',
      );
    try {
      return await searchYoutube(key, text);
    } catch (err) {
      throw new ServiceUnavailableException(
        `YouTube search failed: ${(err as Error).message}`,
      );
    }
  }

  private toAdmin(a: AttractionEntity) {
    return {
      ...toPublicAttraction(a),
      summary: a.summary,
      popularity: a.popularity,
      status: a.status,
      source: a.source,
      sourceId: a.source_id,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
    };
  }
}
