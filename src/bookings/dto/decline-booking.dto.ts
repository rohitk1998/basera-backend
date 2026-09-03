import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class DeclineBookingDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}
