import { Equals, IsBoolean, IsDateString, IsEmail, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateInquiryDto {
  @IsString() @MinLength(2) @MaxLength(80)
  guestName: string;

  /** E.164, e.g. +919876543210 */
  @Matches(/^\+[1-9]\d{7,14}$/, { message: 'guestPhone must be in international format, e.g. +919876543210' })
  guestPhone: string;

  @IsOptional() @IsEmail() @MaxLength(160)
  guestEmail?: string;

  @IsOptional() @IsUUID()
  targetListingId?: string;

  /** Opaque reference; resolved server-side and never echoed. Unknown values are ignored silently. */
  @IsOptional() @IsUUID()
  candidateRef?: string;

  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  destination?: string;

  @IsOptional() @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
  checkIn?: string;

  @IsOptional() @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
  checkOut?: string;

  @IsOptional() @IsInt() @Min(1) @Max(30)
  guests?: number;

  @IsOptional() @IsInt() @Min(0) @Max(10_000_000)
  budgetMin?: number;

  @IsOptional() @IsInt() @Min(0) @Max(10_000_000)
  budgetMax?: number;

  @IsOptional() @IsString() @MaxLength(2000)
  requirements?: string;

  @IsBoolean() @Equals(true, { message: 'You must agree to be contacted about this request.' })
  consentContact: boolean;

  /** Honeypot: real users never see or fill this. */
  @IsOptional() @IsString() @MaxLength(200)
  website?: string;
}

/** Logged-in "Request a stay": name, phone and email come from the account, so only the stay (and optional dates) are sent. */
export class CreateMyInquiryDto {
  @IsOptional() @IsUUID()
  candidateRef?: string;

  @IsOptional() @IsUUID()
  targetListingId?: string;

  @IsOptional() @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
  checkIn?: string;

  @IsOptional() @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
  checkOut?: string;

  @IsOptional() @IsInt() @Min(1) @Max(30)
  guests?: number;
}
