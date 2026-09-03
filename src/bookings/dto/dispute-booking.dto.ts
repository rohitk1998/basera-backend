import { IsString, MaxLength, MinLength } from 'class-validator';

export class DisputeBookingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}
