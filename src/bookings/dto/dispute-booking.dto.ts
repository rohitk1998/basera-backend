import { IsIn, IsInt, IsString, Matches, Min, MaxLength, MinLength, ValidateIf } from 'class-validator';

const DISPUTE_CATEGORIES = ['not_as_described', 'cleanliness', 'damage_safety', 'host_unresponsive_or_cancelled', 'early_departure', 'other'];

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

  // Optional only for an early-departure report (no automatic refund applies).
  @ValidateIf((o: DisputeBookingDto) => o.category !== 'early_departure' || o.requestedAmount != null)
  @IsInt()
  @Min(1)
  requestedAmount?: number;

  // Required only for an early-departure report: the day the guest leaves
  // (YYYY-MM-DD). The today-or-later / before-move-out bounds need the
  // booking, so they're enforced in BookingsService.dispute().
  @ValidateIf((o: DisputeBookingDto) => o.category === 'early_departure')
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  leavingOn?: string;
}
