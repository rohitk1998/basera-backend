import { IsString, MinLength } from 'class-validator';

export class VerifyKycDto {
  @IsString()
  @MinLength(1)
  documentType: string;

  @IsString()
  @MinLength(1)
  documentNumber: string;
}
