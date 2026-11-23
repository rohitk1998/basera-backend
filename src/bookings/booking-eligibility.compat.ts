import { BadRequestException } from '@nestjs/common';

/**
 * Defensive bridge to src/listings/booking-eligibility.util (assertBookable),
 * owned by the listings agent. If that file exists we delegate to it; otherwise
 * a local guard enforces the same rule: a listing is bookable only when it is
 * live, not a discovered (unclaimed) row, and booking_eligible is not false.
 * (Remove the fallback once the shared util is the only path.)
 */
export interface BookableListing {
  status?: string | null;
  is_discovered?: boolean | null;
  booking_eligible?: boolean | null;
}

export function localAssertBookable(listing: BookableListing): void {
  if (listing.is_discovered) throw new BadRequestException('This listing cannot be booked.');
  if (listing.status !== 'live') throw new BadRequestException('This listing is not open for booking requests.');
  if (listing.booking_eligible === false) {
    throw new BadRequestException('This listing is not yet eligible for booking.');
  }
}

export function assertBookableCompat(listing: BookableListing): void {
  let shared: ((l: any) => void) | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    shared = require('../listings/booking-eligibility.util').assertBookable;
  } catch {
    shared = undefined;
  }
  if (typeof shared === 'function') shared(listing);
  else localAssertBookable(listing);
}
