import { IsString, Matches, MinLength } from 'class-validator';

// Ported from web/lib/listing-schema.ts bankingSchema — same shape as the
// per-listing payout banking, but this is IDENTITY proof at the account
// level (see profile.entity.ts bank_upi/bank_account_name/bank_verified_at),
// a distinct concept from a listing's draft_data.banking payout account.
export class BankingVerificationDto {
  @IsString()
  @Matches(/^[\w.+-]+@[\w.-]+$/, { message: 'Enter a valid UPI ID.' })
  upi: string;

  @IsString()
  @MinLength(3, { message: 'Enter the name exactly as your bank has it.' })
  name: string;
}
