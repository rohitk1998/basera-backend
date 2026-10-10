import { IsString, Matches } from 'class-validator';

export class VerifyUpiDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/, { message: 'Enter a valid UPI ID, e.g. name@bank.' })
  vpa: string;
}
