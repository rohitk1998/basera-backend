import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ListEventsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  town?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'from must be a date in YYYY-MM-DD format' })
  from?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
