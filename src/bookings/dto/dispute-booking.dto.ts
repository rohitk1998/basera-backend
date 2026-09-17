import { IsIn, IsInt, IsString, Min, MaxLength, MinLength } from 'class-validator';

const DISPUTE_CATEGORIES = ['not_as_described', 'cleanliness', 'damage_safety', 'host_unresponsive_or_cancelled', 'other'];

/** Kept hand-in-sync with web/lib/dispute-schema.ts's zod shape — the two
 *  can't literally share a definition across the Next.js/NestJS package
 *  boundary, the same reasoning already noted on the bilingual
 *  notification copy catalog. Evidence is never part of this DTO — it's
 *  always added afterward via POST .../dispute/evidence (multipart file
 *  upload), the same two-step "save, then upload" shape as a profile save
 *  followed by an avatar upload, so a URL can never be injected here
 *  without actually going through upload validation. */
export class DisputeBookingDto {
  @IsIn(DISPUTE_CATEGORIES)
  category: string;

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  description: string;

  @IsInt()
  @Min(1)
  requestedAmount: number;
}
