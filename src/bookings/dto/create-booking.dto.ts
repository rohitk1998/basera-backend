import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min, MinLength } from 'class-validator';

export class CreateBookingDto {
  @IsUUID()
  listingId: string;

  @IsString()
  @MinLength(1)
  moveIn: string;

  @IsString()
  @MinLength(1)
  moveOut: string;

  @IsInt()
  @Min(1)
  @Max(730)
  days: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  adults?: number = 1;

  @IsInt()
  @Min(0)
  @IsOptional()
  children?: number = 0;

  @IsInt()
  @Min(0)
  @IsOptional()
  infants?: number = 0;

  @IsInt()
  @Min(0)
  @IsOptional()
  pets?: number = 0;

  @IsIn(['upi', 'cash'])
  paymentMethod: 'upi' | 'cash';

  @IsString()
  @IsOptional()
  role?: 'guest' | 'host';
}
