import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from 'class-validator';

export const BLOG_STATUSES = ['draft', 'published'] as const;
export const BLOG_LOCALES = ['en', 'hi'] as const;
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const URL_OPTS = { require_protocol: true, protocols: ['https', 'http'] };

// Postgres text cannot hold a NUL byte; it would surface as a 500, so drop it at the boundary.
// eslint-disable-next-line no-control-regex
const NUL = /\u0000/g;
const noNul = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(NUL, '') : value;
const noNulEach = ({ value }: { value: unknown }) =>
  Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.replace(NUL, '') : v)) : value;
const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(NUL, '').trim() : value;

export class CreateBlogPostDto {
  @IsOptional()
  @Matches(SLUG, {
    message: 'slug may only contain lowercase letters, numbers and hyphens',
  })
  @MaxLength(120)
  slug?: string;

  @Transform(trimmed)
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(400)
  excerpt?: string;

  @IsOptional()
  @Transform(noNul)
  @IsString()
  @MaxLength(50000)
  bodyMd?: string;

  @IsOptional()
  @IsUrl(URL_OPTS)
  @MaxLength(1000)
  coverImageUrl?: string | null;

  @IsOptional()
  @Transform(noNul)
  @IsString()
  @MaxLength(200)
  coverAlt?: string | null;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(60)
  category?: string | null;

  @IsOptional()
  @Transform(noNulEach)
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(BLOG_LOCALES)
  locale?: (typeof BLOG_LOCALES)[number];

  @IsOptional()
  @Transform(noNul)
  @IsString()
  @MaxLength(70)
  seoTitle?: string | null;

  @IsOptional()
  @Transform(noNul)
  @IsString()
  @MaxLength(170)
  seoDescription?: string | null;

  @IsOptional()
  @IsIn(BLOG_STATUSES)
  status?: (typeof BLOG_STATUSES)[number];
}

export class UpdateBlogPostDto {
  @IsOptional()
  @Matches(SLUG, {
    message: 'slug may only contain lowercase letters, numbers and hyphens',
  })
  @MaxLength(120)
  slug?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(400)
  excerpt?: string;

  @IsOptional()
  @Transform(noNul)
  @IsString()
  @MaxLength(50000)
  bodyMd?: string;

  @IsOptional()
  @IsUrl(URL_OPTS)
  @MaxLength(1000)
  coverImageUrl?: string | null;

  @IsOptional()
  @Transform(noNul)
  @IsString()
  @MaxLength(200)
  coverAlt?: string | null;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(60)
  category?: string | null;

  @IsOptional()
  @Transform(noNulEach)
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(BLOG_LOCALES)
  locale?: (typeof BLOG_LOCALES)[number];

  @IsOptional()
  @Transform(noNul)
  @IsString()
  @MaxLength(70)
  seoTitle?: string | null;

  @IsOptional()
  @Transform(noNul)
  @IsString()
  @MaxLength(170)
  seoDescription?: string | null;

  @IsOptional()
  @IsIn(BLOG_STATUSES)
  status?: (typeof BLOG_STATUSES)[number];
}
