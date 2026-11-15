import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  IsUrl,
} from 'class-validator';

export const MAX_STORY_MEDIA = 8;

export class CreateStoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  body: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  town: string;

  @IsOptional()
  @IsUUID()
  listingId?: string;

  @IsOptional()
  @IsUUID()
  eventId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_STORY_MEDIA)
  @IsUrl({ protocols: ['https'], require_protocol: true }, { each: true })
  mediaUrls?: string[];

  // No default: the author must state a choice, an omitted value is rejected.
  @IsBoolean()
  marketingConsent: boolean;
}
