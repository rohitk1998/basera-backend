import { IsString, MinLength } from 'class-validator';

export class SubscribeDto {
  @IsString()
  @MinLength(1)
  planId: string;

  @IsString()
  @MinLength(1)
  listingId: string;
}
