import { IsString, Length, Matches, MinLength } from 'class-validator';

// JSON-stringified alongside the optional multipart file — see
// VerificationController.submitBank/resubmitBank.
export class SubmitBankDto {
  @IsString()
  @MinLength(3, { message: 'Enter the account holder name exactly as your bank has it.' })
  accountHolderName: string;

  @IsString()
  @MinLength(2, { message: 'Enter your bank name.' })
  bankName: string;

  @IsString()
  @Length(6, 20, { message: 'Enter a valid account number.' })
  @Matches(/^\d+$/, { message: 'Account number must contain digits only.' })
  accountNumber: string;

  @IsString()
  @Length(11, 11, { message: 'IFSC must be exactly 11 characters.' })
  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, { message: 'Enter a valid IFSC code.' })
  ifsc: string;
}
