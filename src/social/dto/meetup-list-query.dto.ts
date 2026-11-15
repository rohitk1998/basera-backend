import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class MeetupListQueryDto {
  @IsOptional()
  @IsUUID()
  listingId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  town?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
