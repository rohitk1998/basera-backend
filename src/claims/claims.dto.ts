import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { CLAIM_ROLES, CLAIM_STATES, EVIDENCE_KINDS } from './claims.constants';

export class StartClaimDto {
  /** Raw signed invitation token from the CRM link. Provide exactly one of token / listingId. */
  @IsOptional() @IsString() @MinLength(16) @MaxLength(256)
  invitationToken?: string;

  @IsOptional() @IsUUID()
  listingId?: string;

  @IsIn(CLAIM_ROLES as unknown as string[])
  role: 'owner' | 'manager';
}

export class UpdateClaimDto {
  @IsOptional() @IsIn(CLAIM_ROLES as unknown as string[]) role?: 'owner' | 'manager';
  @IsOptional() @IsString() @MaxLength(200) businessName?: string;
  @IsOptional() @IsString() @MaxLength(32) contactPhone?: string;
  @IsOptional() @IsEmail() @MaxLength(254) contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(2000) authorityStatement?: string;
  @IsOptional() @IsBoolean() acceptTerms?: boolean;
}

export class EvidenceUploadDto {
  @IsIn(EVIDENCE_KINDS as unknown as string[])
  kind: string;
}

export class CandidateSearchDto {
  @IsString() @MinLength(2) @MaxLength(80)
  destination: string;

  @IsOptional() @IsString() @MaxLength(80)
  q?: string;
}

export class AdminClaimsQueryDto {
  @IsOptional() @IsIn(CLAIM_STATES as unknown as string[]) state?: string;
  @IsOptional() @IsUUID() listingId?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() disputed?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class DecisionNoteDto {
  @IsString() @MinLength(5) @MaxLength(1000)
  note: string;
}

export class OptionalNoteDto {
  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}
