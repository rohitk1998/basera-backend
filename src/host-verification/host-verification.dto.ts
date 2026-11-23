import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class ConsentDto {
  @IsString()
  version: string;
}

export class RejectCaseDto {
  /** Shown to the host, so write it for them. */
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;

  @IsOptional()
  @IsBoolean()
  ban?: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What the reviewer read off the ID and ticked. Required to approve. */
export class ApproveCaseDto {
  @Matches(ISO_DATE, { message: 'dateOfBirth must be YYYY-MM-DD' })
  dateOfBirth: string;

  /** Required for every document except a masked Aadhaar (which prints none). */
  @IsOptional()
  @Matches(ISO_DATE, { message: 'idExpiry must be YYYY-MM-DD' })
  idExpiry?: string;

  @IsBoolean()
  adultConfirmed: boolean;

  @IsOptional()
  @IsBoolean()
  notExpiredConfirmed?: boolean;
}

export class RevokeDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;

  @IsOptional()
  @IsBoolean()
  ban?: boolean;
}

export class QueueQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}
