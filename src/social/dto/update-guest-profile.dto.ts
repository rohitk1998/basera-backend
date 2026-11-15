import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

const trimOrNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  return value.trim() || null;
};

export class UpdateGuestProfileDto {
  /** Explicit opt-in: must be sent as a boolean, never defaulted to true. */
  @IsBoolean()
  visible: boolean;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(80)
  headline?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(60)
  homeCountry?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(60)
  workStatus?: string | null;
}
