import { IsIn, IsInt, IsString, Matches, Min, MaxLength, MinLength, ValidateIf } from 'class-validator';

const DISPUTE_CATEGORIES = ['not_as_described', 'cleanliness', 'damage_safety', 'host_unresponsive_or_cancelled', 'early_departure', 'other'];

export class DisputeBookingDto {
  @IsIn(DISPUTE_CATEGORIES)
  category: string;

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  description: string;

  @ValidateIf((o: DisputeBookingDto) => o.category !== 'early_departure' || o.requestedAmount != null)
  @IsInt()
  @Min(1)
  requestedAmount?: number;

  @ValidateIf((o: DisputeBookingDto) => o.category === 'early_departure')
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  leavingOn?: string;
}
