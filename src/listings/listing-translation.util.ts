import { createHash } from 'crypto';
import type { Listing } from './listing.types';

export type TranslatableFields = {
  title: string;
  description: string;
  theSpace: string | null;
  guestAccess: string | null;
  amenityLabels: string[];
  houseRulesCheckIn: string;
  houseRulesCheckOut: string;
};

export function extractTranslatableFields(listing: Listing): TranslatableFields {
  return {
    title: listing.title,
    description: listing.description,
    theSpace: listing.theSpace ?? null,
    guestAccess: listing.guestAccess ?? null,
    amenityLabels: listing.amenities.map((a) => a.label),
    houseRulesCheckIn: listing.houseRules.checkIn,
    houseRulesCheckOut: listing.houseRules.checkOut,
  };
}

/** Deterministic hash over the translatable fields, in a fixed key order,
 *  so field reordering never changes the hash but any content edit does. */
export function hashTranslatableContent(listing: Listing): string {
  const fields = extractTranslatableFields(listing);
  const stable = JSON.stringify({
    title: fields.title,
    description: fields.description,
    theSpace: fields.theSpace,
    guestAccess: fields.guestAccess,
    amenityLabels: fields.amenityLabels,
    houseRulesCheckIn: fields.houseRulesCheckIn,
    houseRulesCheckOut: fields.houseRulesCheckOut,
  });
  return createHash('sha256').update(stable).digest('hex');
}
