import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_OFFER_TTL_HOURS, MIN_OFFER_TTL_HOURS } from '../offer-pricing.util';

export class CreateOfferDto {
  /** Final total in whole rupees; omit to offer the server-computed price. Bounded server-side. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  adjustedTotal?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  conditions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  hostMessage?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_OFFER_TTL_HOURS)
  @Max(MAX_OFFER_TTL_HOURS)
  expiresInHours?: number;
}

export class DeclineOfferDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
