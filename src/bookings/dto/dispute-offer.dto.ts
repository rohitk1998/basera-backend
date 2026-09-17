import { IsInt, IsOptional, IsString, Min, MaxLength } from 'class-validator';

export class DisputeOfferDto {
  @IsInt()
  @Min(0)
  amountToGuest: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;
}
