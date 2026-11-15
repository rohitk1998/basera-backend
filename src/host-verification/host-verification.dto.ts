import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ConsentDto {
  @IsString()
  version: string;
}

export class RejectCaseDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;

  @IsOptional()
  @IsBoolean()
  ban?: boolean;
}
