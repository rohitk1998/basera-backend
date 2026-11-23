import { ForbiddenException } from '@nestjs/common';

export const NOT_BOOKABLE_MESSAGE =
  'This home is not open for instant booking yet. Send the host an enquiry instead.';

export type BookableListing = {
  status?: string | null;
  is_discovered?: boolean | null;
  booking_eligible?: boolean | null;
};

/** Publication (status = live) and booking eligibility are separate: only an admin flips booking_eligible. */
export function isBookable(listing: BookableListing | null | undefined): boolean {
  return !!listing && listing.status === 'live' && listing.is_discovered !== true && listing.booking_eligible === true;
}

/**
 * Call from the booking-create path (bookings.service create) right after loading the listing row
 * and before any date / payment work. Throws 403 so the web can show the "Enquire" state.
 */
export function assertBookable(listing: BookableListing | null | undefined): void {
  if (!isBookable(listing)) throw new ForbiddenException(NOT_BOOKABLE_MESSAGE);
}
