import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BlogPostEntity } from '../entities';
import { slugify } from '../events/events.service';
import {
  AdminBlogPostDto,
  BlogPostCardDto,
  BlogPostDto,
  toAdminBlogPostDto,
  toBlogPostCardDto,
  toBlogPostDto,
} from './dto/blog.dto';
import { CreateBlogPostDto, SLUG, UpdateBlogPostDto } from './dto/blog-write.dto';
import { ListBlogQueryDto } from './dto/list-blog.dto';

const DEFAULT_PAGE_SIZE = 12;
const PG_UNIQUE_VIOLATION = '23505';
const MAX_SLUG_ATTEMPTS = 50;
const MAX_SLUG_LENGTH = 120;
const RELATED_POOL = 20;
const RELATED_COUNT = 3;

export type BlogListResult = {
  posts: BlogPostCardDto[];
  total: number;
  page: number;
  pageSize: number;
  categories: string[];
};

function cleanTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) return undefined;
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag) seen.add(tag);
  }
  return [...seen];
}

function blankToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

@Injectable()
export class BlogService {
  constructor(
    @InjectRepository(BlogPostEntity)
    private readonly posts: Repository<BlogPostEntity>,
  ) {}

  async listPublic(query: ListBlogQueryDto): Promise<BlogListResult> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const category = query.category?.trim();

    const qb = this.posts
      .createQueryBuilder('p')
      .where('p.status = :status', { status: 'published' })
      .orderBy('p.published_at', 'DESC')
      .addOrderBy('p.id', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    if (category) {
      qb.andWhere('LOWER(p.category) = LOWER(:category)', { category });
    }
    const [rows, total] = await qb.getManyAndCount();

    return {
      posts: rows.map(toBlogPostCardDto),
      total,
      page,
      pageSize,
      categories: await this.publishedCategories(),
    };
  }

  async getPublicBySlug(
    slug: string,
  ): Promise<{ post: BlogPostDto; related: BlogPostCardDto[] }> {
    // Anything that is not a valid slug cannot exist, and never reaches the database.
    if (slug.length > MAX_SLUG_LENGTH || !SLUG.test(slug)) {
      throw new NotFoundException('Post not found.');
    }
    const row = await this.posts.findOne({ where: { slug, status: 'published' } });
    if (!row) throw new NotFoundException('Post not found.');

    const others = await this.posts
      .createQueryBuilder('p')
      .where('p.status = :status', { status: 'published' })
      .andWhere('p.id <> :id', { id: row.id })
      .orderBy('p.published_at', 'DESC')
      .limit(RELATED_POOL)
      .getMany();
    // Same-category posts first, newest first within each group (the pool is already date-sorted).
    const sameCategory = (p: BlogPostEntity) => (row.category && p.category === row.category ? 0 : 1);
    const relatedRows = [...others]
      .sort((a, b) => sameCategory(a) - sameCategory(b))
      .slice(0, RELATED_COUNT);

    return { post: toBlogPostDto(row), related: relatedRows.map(toBlogPostCardDto) };
  }

  async listAdmin(): Promise<AdminBlogPostDto[]> {
    const rows = await this.posts.find({ order: { updated_at: 'DESC' } });
    return rows.map(toAdminBlogPostDto);
  }

  async getAdmin(id: string): Promise<AdminBlogPostDto> {
    const row = await this.posts.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Post not found.');
    return toAdminBlogPostDto(row);
  }

  async create(dto: CreateBlogPostDto, authorId: string | null): Promise<AdminBlogPostDto> {
    const explicitSlug = dto.slug;
    const base = explicitSlug ?? slugify(dto.title);
    if (!base) throw new BadRequestException('Could not build a slug from the title.');

    const status = dto.status ?? 'draft';
    const baseRow = this.posts.create({
      title: dto.title.trim(),
      excerpt: dto.excerpt ?? '',
      body_md: dto.bodyMd ?? '',
      cover_image_url: blankToNull(dto.coverImageUrl) ?? null,
      cover_alt: blankToNull(dto.coverAlt) ?? null,
      category: blankToNull(dto.category) ?? null,
      tags: cleanTags(dto.tags) ?? [],
      locale: dto.locale ?? 'en',
      seo_title: blankToNull(dto.seoTitle) ?? null,
      seo_description: blankToNull(dto.seoDescription) ?? null,
      status,
      published_at: status === 'published' ? new Date() : null,
      author_id: authorId,
    });

    // An explicit slug that is taken is the admin's mistake (409). A slug derived from the
    // title just gets a numeric suffix.
    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = attempt === 1 ? base : `${base}-${attempt}`;
      try {
        return toAdminBlogPostDto(await this.posts.save({ ...baseRow, slug }));
      } catch (err) {
        if (!this.isUniqueViolation(err)) throw err;
        if (explicitSlug) throw this.slugTaken();
      }
    }
    throw this.slugTaken();
  }

  async update(id: string, dto: UpdateBlogPostDto): Promise<AdminBlogPostDto> {
    const row = await this.posts.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Post not found.');

    if (dto.slug !== undefined) row.slug = dto.slug;
    if (dto.title !== undefined) row.title = dto.title.trim();
    if (dto.excerpt !== undefined) row.excerpt = dto.excerpt;
    if (dto.bodyMd !== undefined) row.body_md = dto.bodyMd;
    if (dto.coverImageUrl !== undefined) row.cover_image_url = blankToNull(dto.coverImageUrl) ?? null;
    if (dto.coverAlt !== undefined) row.cover_alt = blankToNull(dto.coverAlt) ?? null;
    if (dto.category !== undefined) row.category = blankToNull(dto.category) ?? null;
    if (dto.tags !== undefined) row.tags = cleanTags(dto.tags) ?? [];
    if (dto.locale !== undefined) row.locale = dto.locale;
    if (dto.seoTitle !== undefined) row.seo_title = blankToNull(dto.seoTitle) ?? null;
    if (dto.seoDescription !== undefined) row.seo_description = blankToNull(dto.seoDescription) ?? null;
    if (dto.status !== undefined) {
      row.status = dto.status;
      // The first publish stamps the date; unpublishing and republishing keeps it.
      if (dto.status === 'published' && !row.published_at) row.published_at = new Date();
    }

    try {
      return toAdminBlogPostDto(await this.posts.save(row));
    } catch (err) {
      if (this.isUniqueViolation(err)) throw this.slugTaken();
      throw err;
    }
  }

  async remove(id: string): Promise<void> {
    const result = await this.posts.delete({ id });
    if (!result.affected) throw new NotFoundException('Post not found.');
  }

  private async publishedCategories(): Promise<string[]> {
    const rows = await this.posts
      .createQueryBuilder('p')
      .select('p.category', 'category')
      .where('p.status = :status', { status: 'published' })
      .andWhere('p.category IS NOT NULL')
      .groupBy('p.category')
      .orderBy('p.category', 'ASC')
      .getRawMany<{ category: string }>();
    return rows.map((r) => r.category);
  }

  private isUniqueViolation(err: unknown): boolean {
    return (err as { code?: string } | null)?.code === PG_UNIQUE_VIOLATION;
  }

  private slugTaken(): ConflictException {
    return new ConflictException('A post with this slug already exists.');
  }
}
