import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export const BOOKING_STATUSES = [
  'requested', 'host_review', 'offered', 'awaiting_payment', 'approved', 'confirmed',
  'checked_in', 'checked_out', 'disputed', 'completed', 'declined', 'cancelled', 'expired',
] as const;
export const PAYMENT_STATUSES = ['none', 'pending', 'held', 'released_to_host', 'split', 'refunded', 'failed'] as const;

export class ListAdminBookingsDto {
  @IsOptional() @IsIn(BOOKING_STATUSES as unknown as string[]) status?: string;
  @IsOptional() @IsUUID() listing?: string;
  @IsOptional() @IsUUID() host?: string;
  @IsOptional() @IsUUID() guest?: string;
  /** Check-in (move_in) range, inclusive start, exclusive end. */
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsIn(PAYMENT_STATUSES as unknown as string[]) paymentStatus?: string;
  /** Reference (RB-XXXXXX, prefix ok) or guest name fragment. */
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class AdminCancelBookingDto {
  @IsString() @MinLength(5) @MaxLength(1000) reason: string;
  /** Required when the booking is disputed: rupees refunded to the guest (0..payment). */
  @IsOptional() @IsInt() @Min(0) amountToGuest?: number;
  /** Non-disputed bookings: full refund, cancellation-policy refund, or none (reason >= 10 chars). Defaults to policy. */
  @IsOptional() @IsIn(['full', 'policy', 'none']) refundMode?: 'full' | 'policy' | 'none';
}
