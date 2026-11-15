import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateMeetupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  description: string;

  @IsISO8601()
  startsAt: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  placeText: string;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(50)
  capacity?: number | null;

  @IsOptional()
  @IsUUID()
  listingId?: string | null;

  @IsOptional()
  @IsUUID()
  eventId?: string | null;

  // Required when no listingId is given; otherwise the town is taken from the listing.
  @IsOptional()
  @IsString()
  @MaxLength(80)
  town?: string;
}
