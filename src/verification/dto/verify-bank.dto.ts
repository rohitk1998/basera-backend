import { IsString, Length, Matches, MinLength } from 'class-validator';

export class VerifyBankDto {
  @IsString()
  @MinLength(3, { message: 'Enter the account holder name exactly as your bank has it.' })
  accountHolderName: string;

  @IsString()
  @Length(6, 20, { message: 'Enter a valid account number.' })
  @Matches(/^\d+$/, { message: 'Account number must contain digits only.' })
  accountNumber: string;

  @IsString()
  @Length(11, 11, { message: 'IFSC must be exactly 11 characters.' })
  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, { message: 'Enter a valid IFSC code.' })
  ifsc: string;
}
