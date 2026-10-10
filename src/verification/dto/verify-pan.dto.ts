import { IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class VerifyPanDto {
  @IsString()
  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, { message: 'Enter a valid 10-character PAN, e.g. ABCPV1234D.' })
  pan: string;

  // Defaults to the name on the user's profile when omitted.
  @IsOptional()
  @IsString()
  @MinLength(3, { message: 'Enter your name as it appears on your PAN card.' })
  name?: string;
}
