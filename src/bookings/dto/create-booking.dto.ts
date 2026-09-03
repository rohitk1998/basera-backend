import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min, MinLength } from 'class-validator';

// Mirrors web/lib/... createSchema in app/api/bookings/route.ts:
//   listingId: z.string().uuid()
//   moveIn/moveOut: z.string().min(1)
//   months: z.coerce.number().int().min(1).max(24)
//   paymentMethod: z.enum(['upi', 'cash'])
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
  @Max(730) // Max 2 years in days
  days: number;

  @IsIn(['upi', 'cash'])
  paymentMethod: 'upi' | 'cash';

  // Optional for backward compatibility, but allows enforcing guest mode
  @IsString()
  @IsOptional()
  role?: 'guest' | 'host';
}
