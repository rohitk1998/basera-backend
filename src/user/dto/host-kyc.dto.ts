import { IsIn, IsString, Length, Matches, ValidateIf } from 'class-validator';

// Ported from web/lib/listing-schema.ts hostKycSchema (kindSchema + identitySchema + legalSchema).
export class HostKycDto {
  @IsIn(['individual', 'business'])
  host_kind: 'individual' | 'business';

  @IsString()
  @Matches(/^[A-Z]{5}\d{4}[A-Z]$/, { message: 'Enter a valid 10-character PAN.' })
  pan: string;

  // Optional, but @IsOptional() alone only exempts undefined/null — an
  // individual host sends gst: '' (not omitted), which class-validator's
  // @IsOptional() still runs @Length against. ValidateIf skips validation
  // for '' specifically, matching the original zod schema's
  // .optional().or(z.literal('')).
  @ValidateIf((o) => o.gst !== '')
  @IsString()
  @Length(15, 15, { message: 'GSTIN is 15 characters.' })
  gst?: string;

  // HP Tourism numbers look like HP/HS/1234/2025.
  @IsString()
  @Matches(/^HP\/HS\/\d{3,5}\/\d{4}$/i, { message: 'Format: HP/HS/1234/2025.' })
  registrationNumber: string;
}
