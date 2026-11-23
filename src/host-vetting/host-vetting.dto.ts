import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AUDIT_OUTCOMES, RATING_SOURCES } from './host-vetting.constants';
import type { AuditOutcome, RatingSource } from './host-vetting.constants';

export class SetRatingDto {
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(5)
  rating: number;

  @IsIn(RATING_SOURCES)
  source: RatingSource;

  @IsInt()
  @Min(0)
  reviewCount: number;

  @IsOptional()
  @Matches(/^https:\/\/\S+$/i, { message: 'url must be an https link' })
  @MaxLength(500)
  url?: string;
}

export class AddAuditDto {
  @IsIn(AUDIT_OUTCOMES)
  outcome: AuditOutcome;

  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  note: string;
}
