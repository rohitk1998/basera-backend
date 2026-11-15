import { Type } from 'class-transformer';
import {
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ISO_DATE } from './list-events.dto';

export const EVENT_STATUSES = ['draft', 'published'] as const;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateEventDto {
  @IsOptional()
  @Matches(SLUG, {
    message: 'slug may only contain lowercase letters, numbers and hyphens',
  })
  @MaxLength(120)
  slug?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  description: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  town: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  district: string;

  @Matches(ISO_DATE, {
    message: 'startsOn must be a date in YYYY-MM-DD format',
  })
  startsOn: string;

  @Matches(ISO_DATE, { message: 'endsOn must be a date in YYYY-MM-DD format' })
  endsOn: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number | null;

  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['https', 'http'] })
  @MaxLength(1000)
  imageUrl?: string | null;

  @IsOptional()
  @IsIn(EVENT_STATUSES)
  status?: (typeof EVENT_STATUSES)[number];
}

export class UpdateEventDto {
  @IsOptional()
  @Matches(SLUG, {
    message: 'slug may only contain lowercase letters, numbers and hyphens',
  })
  @MaxLength(120)
  slug?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  town?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  district?: string;

  @IsOptional()
  @Matches(ISO_DATE, {
    message: 'startsOn must be a date in YYYY-MM-DD format',
  })
  startsOn?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'endsOn must be a date in YYYY-MM-DD format' })
  endsOn?: string;

  // null clears the value; undefined leaves it unchanged.
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @Type(() => Number)
  @IsLatitude()
  lat?: number | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @Type(() => Number)
  @IsLongitude()
  lng?: number | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsUrl({ require_protocol: true, protocols: ['https', 'http'] })
  @MaxLength(1000)
  imageUrl?: string | null;

  @IsOptional()
  @IsIn(EVENT_STATUSES)
  status?: (typeof EVENT_STATUSES)[number];
}
