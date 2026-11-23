import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf,
} from 'class-validator';
import { DISCOVERY_STATES } from './discovery.constants';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const categories = () => [IsArray(), ArrayMaxSize(10), IsString({ each: true }), MaxLength(40, { each: true }), MinLength(2, { each: true })];
const apply = (decs: PropertyDecorator[]) => (t: object, k: string | symbol) => decs.forEach((d) => d(t, k));

export class PutSettingsDto {
  @IsOptional() @apply(categories()) categories?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(5_000) max_new_per_run?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) daily_request_budget?: number;
  /** Standard 5-field cron (UTC); null/'' clears the schedule. Validated again in the service. */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(100) schedule_cron?: string | null;
  @IsOptional() @IsBoolean() paused?: boolean;
}

export class CreateJobDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) destination: string;
  @IsOptional() @apply(categories()) categories?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5_000) maxNew?: number;
  @IsOptional() @IsString() @MaxLength(120) @Matches(/^[A-Za-z0-9:_.-]+$/) idempotencyKey?: string;
}

export class RunNowDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) destination: string;
}

export class ListJobsDto {
  @IsOptional() @IsIn(['queued', 'running', 'paused', 'cancelled', 'done', 'failed']) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}

export class ListCandidatesDto {
  @IsOptional() @IsString() @MaxLength(80) destination?: string;
  @IsOptional() @IsIn(DISCOVERY_STATES as unknown as string[]) state?: string;
  @IsOptional() @IsString() @MaxLength(40) category?: string;
  @IsOptional() @IsUUID() assigned_to?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}

export class TransitionDto {
  @IsIn(DISCOVERY_STATES as unknown as string[]) to: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class AssignDto {
  /** null un-assigns. */
  @ValidateIf((_o, v) => v !== null) @IsUUID() assigned_to: string | null;
}

export class DuplicateDto {
  @IsUUID() duplicate_of: string;
}

export class UsageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) days?: number;
}
