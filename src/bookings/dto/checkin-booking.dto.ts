import { IsString, Matches } from 'class-validator';

export class CheckinBookingDto {
  @IsString()
  @Matches(/^\d{4}$/, { message: 'code must be a 4-digit number' })
  code: string;
}
