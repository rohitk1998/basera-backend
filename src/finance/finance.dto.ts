import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

export class CreateAgreementDto {
  @IsIn(['global', 'host', 'property']) scope: 'global' | 'host' | 'property';
  @ValidateIf((o) => o.scope !== 'global') @IsUUID() scopeId?: string;
  @IsInt() @Min(0) @Max(3000) rateBps: number;
  @IsOptional() @IsISO8601() effectiveFrom?: string;
  @IsOptional() @IsISO8601() effectiveTo?: string;
  @IsOptional() @IsInt() @Min(0) freePeriodCap?: number;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class UpdateAgreementDto {
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsISO8601() effectiveTo?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(0) freePeriodCap?: number | null;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class SettingDto {
  // validated per key in the controller (WRITABLE_SETTINGS)
  value: unknown;
}

export class RequestAdjustmentDto {
  @IsUUID() hostId: string;
  @IsOptional() @IsUUID() bookingId?: string;
  @IsIn(['host_credit', 'host_debit']) direction: 'host_credit' | 'host_debit';
  @IsInt() @Min(1) @Max(10_000_000) amount: number;
  @IsString() @MinLength(5) @MaxLength(1000) reason: string;
}

export class DecisionDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class ApprovePayoutDto {
  @IsOptional() @IsIn(['manual', 'cashfree']) provider?: 'manual' | 'cashfree';
}

export class MarkPaidDto {
  @IsString() @MinLength(4) @MaxLength(100) bankReference: string;
}

export class FailPayoutDto {
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class PageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @IsString() @MaxLength(32) status?: string;
  @IsOptional() @IsUUID() hostId?: string;
  @IsOptional() @IsUUID() guestId?: string;
  @IsOptional() @IsUUID() bookingId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}
