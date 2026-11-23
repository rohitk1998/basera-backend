/**
 * Pure check: can this guest's request be handed to the owner as a normal booking request?
 * Works only on stored columns (never Google). Reasons are shown to admins verbatim, in this exact order.
 */
export interface ReadinessListing {
  id: string;
  status: string;
  is_discovered: boolean;
  host_id: string | null;
  booking_eligible: boolean;
}

export interface ReadinessInquiry {
  candidate_listing_id: string | null;
  guest_user_id: string | null;
  check_in: string | Date | null;
  check_out: string | Date | null;
}

export type Readiness = { ok: true } | { ok: false; reason: string };

export function candidateReadiness(
  listing: ReadinessListing | null | undefined,
  inquiry: ReadinessInquiry,
): Readiness {
  const no = (reason: string): Readiness => ({ ok: false, reason });
  if (!inquiry.candidate_listing_id) return no('No property attached to this request');
  if (!listing) return no('The property no longer exists');
  if (listing.is_discovered || !listing.host_id) return no('The owner has not claimed this property yet');
  if (listing.status !== 'live') {
    return no(`Claimed, but the listing is still ${listing.status}: the host must submit it and you must set it live`);
  }
  if (listing.booking_eligible !== true) {
    return no('Live, but booking is not enabled for this listing: enable booking eligibility in listing admin');
  }
  if (!inquiry.guest_user_id) return no('The guest has no account: use "Dates not available" instead');
  if (!inquiry.check_in || !inquiry.check_out) return no('The request has no dates');
  if (listing.host_id === inquiry.guest_user_id) return no('The owner is the guest');
  return { ok: true };
}
