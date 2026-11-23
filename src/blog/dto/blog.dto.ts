import type { BlogPostEntity } from '../../entities';

const WORDS_PER_MINUTE = 200;

export type BlogPostCardDto = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  coverImageUrl: string | null;
  coverAlt: string | null;
  category: string | null;
  tags: string[];
  publishedAt: string | null;
  readingMinutes: number;
};

export type BlogPostDto = BlogPostCardDto & {
  bodyMd: string;
  locale: string;
  seoTitle: string | null;
  seoDescription: string | null;
  updatedAt: string;
};

export type AdminBlogPostDto = BlogPostDto & {
  status: 'draft' | 'published';
  createdAt: string;
};

export function readingMinutes(markdown: string): number {
  const words = markdown.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

export function toBlogPostCardDto(row: BlogPostEntity): BlogPostCardDto {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    coverImageUrl: row.cover_image_url ?? null,
    coverAlt: row.cover_alt ?? null,
    category: row.category ?? null,
    tags: row.tags ?? [],
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
    readingMinutes: readingMinutes(row.body_md),
  };
}

export function toBlogPostDto(row: BlogPostEntity): BlogPostDto {
  return {
    ...toBlogPostCardDto(row),
    bodyMd: row.body_md,
    locale: row.locale,
    seoTitle: row.seo_title ?? null,
    seoDescription: row.seo_description ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toAdminBlogPostDto(row: BlogPostEntity): AdminBlogPostDto {
  return {
    ...toBlogPostDto(row),
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}
