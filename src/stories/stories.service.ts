import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EventEntity, StoryEntity, UserEntity } from '../entities';
import type { StoryStatus } from '../entities/story.entity';
import { SocialAccessService } from '../social/social-access.service';
import { CreateStoryDto, MAX_STORY_MEDIA } from './dto/create-story.dto';

export type StoryDto = {
  id: string;
  title: string;
  body: string;
  town: string;
  mediaUrls: string[];
  authorFirstName: string;
  authorAvatarUrl: string | null;
  listingId: string | null;
  eventId: string | null;
  publishedAt: string | null;
};

export type AuthorStoryDto = StoryDto & {
  status: string;
  marketingConsent: boolean;
  createdAt: string;
};

export type AdminStoryDto = AuthorStoryDto & { authorId: string };

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;
const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STORY_MEDIA_PATH = new RegExp(
  `^/storage/v1/object/public/story-media/(${UUID_PATTERN})/${UUID_PATTERN}\\.(?:jpg|png|webp)$`,
  'i',
);
const FALLBACK_FIRST_NAME = 'Guest';

@Injectable()
export class StoriesService {
  constructor(
    @InjectRepository(StoryEntity)
    private readonly storiesRepo: Repository<StoryEntity>,
    @InjectRepository(UserEntity)
    private readonly usersRepo: Repository<UserEntity>,
    @InjectRepository(EventEntity)
    private readonly eventsRepo: Repository<EventEntity>,
    private readonly access: SocialAccessService,
    private readonly config: ConfigService,
  ) {}

  /** Public feed: only published stories whose author currently consents. Newest first, keyset paginated. */
  async listPublic(params: { town?: string; limit?: number; cursor?: string }) {
    const limit = Math.min(
      Math.max(Math.trunc(params.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const qb = this.publicQuery();
    if (params.town?.trim())
      qb.andWhere('LOWER(s.town) = LOWER(:town)', { town: params.town.trim() });
    if (params.cursor) {
      const { publishedAt, id } = this.decodeCursor(params.cursor);
      qb.andWhere('(s.published_at, s.id) < (:publishedAt, :id)', {
        publishedAt,
        id,
      });
    }
    const rows = await qb
      .orderBy('s.published_at', 'DESC')
      .addOrderBy('s.id', 'DESC')
      .take(limit + 1)
      .getMany();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last ? this.encodeCursor(last) : null;
    return { stories: await this.toDtos(page), nextCursor };
  }

  async getPublic(id: string): Promise<StoryDto> {
    const story = await this.publicQuery()
      .andWhere('s.id = :id', { id })
      .getOne();
    if (!story) throw new NotFoundException('Story not found');
    return (await this.toDtos([story]))[0];
  }

  async create(userId: string, dto: CreateStoryDto) {
    if (typeof dto.marketingConsent !== 'boolean') {
      throw new BadRequestException('marketingConsent must be true or false');
    }
    const listingId = dto.listingId ?? null;
    if (listingId)
      await this.access.assertStoryAuthorOfListing(userId, listingId);

    const eventId = dto.eventId ?? null;
    if (eventId) {
      const event = await this.eventsRepo.findOne({
        where: { id: eventId, status: 'published' },
      });
      if (!event) throw new BadRequestException('Event not found');
    }

    const title = dto.title.trim();
    const body = dto.body.trim();
    const town = dto.town.trim();
    if (!title || !body || !town)
      throw new BadRequestException('Title, story and town are required');

    const saved = await this.storiesRepo.save(
      this.storiesRepo.create({
        author_id: userId,
        listing_id: listingId,
        event_id: eventId,
        booking_id: null,
        town,
        title,
        body,
        media_urls: this.validateMediaUrls(dto.mediaUrls ?? [], userId),
        marketing_consent: dto.marketingConsent,
        consent_at: dto.marketingConsent ? new Date() : null,
        status: 'pending',
        published_at: null,
      }),
    );
    return { success: true, story: (await this.toAuthorDtos([saved]))[0] };
  }

  async listMine(userId: string) {
    const rows = await this.storiesRepo.find({
      where: { author_id: userId },
      order: { created_at: 'DESC' },
    });
    return { stories: await this.toAuthorDtos(rows) };
  }

  /**
   * Author-only. Withdrawing consent hides the story everywhere (status withdrawn). Granting consent on a
   * withdrawn story sends it back to pending so it is moderated again before it can go public.
   */
  async setConsent(userId: string, storyId: string, marketingConsent: boolean) {
    const story = await this.storiesRepo.findOne({ where: { id: storyId } });
    if (!story) throw new NotFoundException('Story not found');
    if (story.author_id !== userId)
      throw new ForbiddenException('Only the author can change consent');

    if (!marketingConsent) {
      story.marketing_consent = false;
      story.status = 'withdrawn';
    } else if (!story.marketing_consent) {
      story.marketing_consent = true;
      story.consent_at = new Date();
      if (story.status === 'withdrawn') {
        story.status = 'pending';
        story.published_at = null;
      }
    }
    const saved = await this.storiesRepo.save(story);
    return { success: true, story: (await this.toAuthorDtos([saved]))[0] };
  }

  async listForAdmin(status?: string) {
    const rows = await this.storiesRepo.find({
      where: status ? { status: status as StoryStatus } : {},
      order: { created_at: 'DESC' },
      take: 200,
    });
    const dtos = await this.toAuthorDtos(rows);
    return {
      stories: dtos.map(
        (dto, i) =>
          ({ ...dto, authorId: rows[i].author_id }) satisfies AdminStoryDto,
      ),
    };
  }

  async moderate(storyId: string, status: 'published' | 'rejected') {
    const story = await this.storiesRepo.findOne({ where: { id: storyId } });
    if (!story) throw new NotFoundException('Story not found');
    if (story.status === 'withdrawn')
      throw new BadRequestException('The author withdrew this story');

    // Single conditional UPDATEs so a concurrent consent withdrawal can never be overwritten by stale state.
    const result =
      status === 'published'
        ? await this.storiesRepo
            .createQueryBuilder()
            .update(StoryEntity)
            .set({
              status: 'published',
              published_at: () => 'COALESCE(published_at, now())',
            })
            .where('id = :id AND marketing_consent = true', { id: storyId })
            .andWhere("status <> 'withdrawn'")
            .execute()
        : await this.storiesRepo
            .createQueryBuilder()
            .update(StoryEntity)
            .set({ status: 'rejected', published_at: null })
            .where('id = :id', { id: storyId })
            .andWhere("status <> 'withdrawn'")
            .execute();
    if (!result.affected)
      throw new BadRequestException(
        status === 'published'
          ? 'Cannot publish: the story has no marketing consent or was withdrawn'
          : 'The author withdrew this story',
      );
    const saved = await this.storiesRepo.findOneOrFail({
      where: { id: storyId },
    });
    return { success: true, story: (await this.toAuthorDtos([saved]))[0] };
  }

  private publicQuery() {
    return this.storiesRepo
      .createQueryBuilder('s')
      .where('s.status = :status', { status: 'published' })
      .andWhere('s.marketing_consent = true');
  }

  /**
   * Media must be an object this backend uploaded: https, this project's Supabase host, the public
   * story-media bucket, path <userId>/<uuid>.(jpg|png|webp), no query or fragment.
   */
  private validateMediaUrls(urls: string[], authorId: string): string[] {
    if (urls.length > MAX_STORY_MEDIA)
      throw new BadRequestException(
        `At most ${MAX_STORY_MEDIA} photos or videos`,
      );
    const storageHost = this.storageHost();
    return urls.map((raw) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new BadRequestException('Invalid media URL');
      }
      const ok =
        !!storageHost &&
        url.protocol === 'https:' &&
        url.host === storageHost &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password &&
        this.isOwnStoryMedia(url.pathname, authorId);
      if (!ok) {
        throw new BadRequestException('Media must be uploaded through RhenBasera');
      }
      return url.toString();
    });
  }

  /** The first path segment is the uploader's user id; authors may only attach their own uploads. */
  private isOwnStoryMedia(pathname: string, authorId: string): boolean {
    const match = STORY_MEDIA_PATH.exec(pathname);
    return !!match && match[1].toLowerCase() === authorId.toLowerCase();
  }

  private storageHost(): string | null {
    const base = this.config.get<string>('NEXT_PUBLIC_SUPABASE_URL');
    try {
      return base ? new URL(base).host : null;
    } catch {
      return null;
    }
  }

  private encodeCursor(story: StoryEntity): string {
    const publishedAt = (story.published_at ?? new Date(0)).toISOString();
    return Buffer.from(`${publishedAt}|${story.id}`).toString('base64url');
  }

  private decodeCursor(cursor: string): { publishedAt: string; id: string } {
    const [publishedAt, id] = Buffer.from(cursor, 'base64url')
      .toString()
      .split('|');
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      !publishedAt ||
      !id ||
      Number.isNaN(Date.parse(publishedAt)) ||
      !uuid.test(id)
    ) {
      throw new BadRequestException('Invalid cursor');
    }
    return { publishedAt, id };
  }

  /** Only first name and avatar leave this service: never email, phone or last name. */
  private async authorMap(rows: StoryEntity[]) {
    const ids = Array.from(new Set(rows.map((r) => r.author_id)));
    const users = ids.length
      ? await this.usersRepo.find({ where: { id: In(ids) } })
      : [];
    return new Map(
      users.map((u) => [
        u.id,
        {
          firstName: this.firstName(u.full_name),
          avatarUrl: u.avatar_url ?? null,
        },
      ]),
    );
  }

  private firstName(fullName: string | null): string {
    return fullName?.trim().split(/\s+/)[0] || FALLBACK_FIRST_NAME;
  }

  private async toDtos(rows: StoryEntity[]): Promise<StoryDto[]> {
    const authors = await this.authorMap(rows);
    return rows.map((s) => {
      const author = authors.get(s.author_id);
      return {
        id: s.id,
        title: s.title,
        body: s.body,
        town: s.town,
        mediaUrls: s.media_urls ?? [],
        authorFirstName: author?.firstName ?? FALLBACK_FIRST_NAME,
        authorAvatarUrl: author?.avatarUrl ?? null,
        listingId: s.listing_id ?? null,
        eventId: s.event_id ?? null,
        publishedAt: s.published_at
          ? new Date(s.published_at).toISOString()
          : null,
      };
    });
  }

  private async toAuthorDtos(rows: StoryEntity[]): Promise<AuthorStoryDto[]> {
    const base = await this.toDtos(rows);
    return base.map((dto, i) => ({
      ...dto,
      status: rows[i].status,
      marketingConsent: rows[i].marketing_consent,
      createdAt: new Date(rows[i].created_at).toISOString(),
    }));
  }
}
