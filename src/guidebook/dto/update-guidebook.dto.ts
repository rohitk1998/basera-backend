import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { sanitizeText } from '../sanitize-text';

export const GUIDEBOOK_MAX_SECTIONS = 12;
export const GUIDEBOOK_TITLE_MAX = 80;
export const GUIDEBOOK_BODY_MAX = 2000;

// Plain text only: guests render this as text, never HTML. Length caps run after this.
// Raw input far beyond the cap is passed through untouched so @MaxLength rejects it without running the regexes.
const RAW_LENGTH_FACTOR = 4;
const plainTextWithin = (max: number) =>
  ({ value }: { value: unknown }) =>
    typeof value === 'string' && value.length <= max * RAW_LENGTH_FACTOR ? sanitizeText(value) : value;

export class GuidebookSectionDto {
  @Transform(plainTextWithin(GUIDEBOOK_TITLE_MAX))
  @IsString()
  @IsNotEmpty()
  @MaxLength(GUIDEBOOK_TITLE_MAX)
  title: string;

  @Transform(plainTextWithin(GUIDEBOOK_BODY_MAX))
  @IsString()
  @IsNotEmpty()
  @MaxLength(GUIDEBOOK_BODY_MAX)
  body: string;
}

export class UpdateGuidebookDto {
  @IsArray()
  @ArrayMaxSize(GUIDEBOOK_MAX_SECTIONS)
  @ValidateNested({ each: true })
  @Type(() => GuidebookSectionDto)
  sections: GuidebookSectionDto[];
}
