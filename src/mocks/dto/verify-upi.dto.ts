import { IsString, MinLength } from 'class-validator';

export class VerifyUpiDto {
  @IsString()
  @MinLength(1)
  upiId: string;
}
