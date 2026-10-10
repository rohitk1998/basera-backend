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

  // Mirrors web/components/GuestsPicker.tsx's GuestCounts shape exactly —
  // adults defaults to 1 (a booking always has at least the requester),
  // the rest default to 0, same as that component's EMPTY_GUESTS baseline.
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

  // Optional for backward compatibility, but allows enforcing guest mode
  @IsString()
  @IsOptional()
  role?: 'guest' | 'host';
}
