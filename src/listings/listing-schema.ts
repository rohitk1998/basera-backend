import { z } from 'zod';
import { HP_DISTRICTS } from './hp-locations';

/* Ported from web/lib/listing-schema.ts. One schema per wizard step, composed
   into a whole-listing schema — kept as zod here (rather than class-validator
   DTOs) so every min/max/regex rule is copy-identical to the Next.js app's,
   which the client there also imports from. */

/** "₹12,000" / "12,000" / "12000" → 12000. Integer rupees, never a float. */
export const parseRupees = (v: unknown) => {
  if (typeof v === 'number') return Math.round(v);
  const digits = String(v ?? '').replace(/[^\d]/g, '');
  return digits ? Number.parseInt(digits, 10) : Number.NaN;
};

/* The full Airbnb-style category set, kept even for types unlikely to ever
   list here (Boat, Windmill, Yurt, ...) — parity with the reference flow
   was an explicit product decision, not an oversight. */
export const PROPERTY_TYPES = [
  'house',
  'flat',
  'barn',
  'bnb',
  'boat',
  'cabin',
  'campervan',
  'casaParticular',
  'castle',
  'cave',
  'container',
  'cycladicHome',
  'dammuso',
  'dome',
  'earthHome',
  'farm',
  'guestHouse',
  'hotel',
  'houseboat',
  'minsu',
  'riad',
  'ryokan',
  'shepherdsHut',
  'tent',
  'tinyHome',
  'tower',
  'treeHouse',
  'trullo',
  'windmill',
  'yurt',
] as const;

export const PLACE_TYPES = ['entire', 'room', 'sharedRoom'] as const;

/* Ported from web/lib/districts.ts (PLACES) — the platform only operates in
   Himachal Pradesh, so town is drawn from this curated list of HP tourist
   towns, and state is a fixed literal rather than free text. Keep this array
   byte-for-byte identical to web/lib/districts.ts's PLACES. */
export const PLACES = [
  'Manali',
  'Shimla',
  'Dharamshala',
  'McLeodganj',
  'Kasol',
  'Bir',
  'Dalhousie',
  'Kullu',
  'Palampur',
  'Spiti Valley',
  'Chamba',
  'Kufri',
  'Manikaran',
  'Tosh',
  'Barot',
  'Chitkul',
  'Sarahan',
  'Narkanda',
] as const;

export const HIMACHAL_PRADESH = 'Himachal Pradesh' as const;

export const basicsSchema = z.object({
  title: z
    .string()
    .trim()
    .min(4, 'Give the home a name — at least 4 characters.')
    .max(60, 'Keep the name under 60 characters.'),
  propertyType: z.enum(PROPERTY_TYPES),
  placeType: z.enum(PLACE_TYPES),
  beds: z.enum(['Studio', '1BHK', '2BHK', '3BHK']),
  bedrooms: z.coerce.number().int().min(0).max(10),
  bathrooms: z.coerce.number().int().min(1, 'At least one bathroom.').max(10),
  maxGuests: z.coerce.number().int().min(1, 'At least one guest.').max(20),
});

export const locationSchema = z.object({
  /* Where in Himachal Pradesh: a district, then a tehsil under it. `town` is
     the place name the public site groups, filters and searches by — the
     clients set it to the tehsil. Whether the tehsil belongs to the district,
     and whether the pin is inside the state, is checked by
     assertLocationIsValid (location.util.ts), because this object is merged
     into larger schemas and cannot carry a refinement itself. */
  district: z.enum(HP_DISTRICTS, { message: 'Choose the district.' }),
  tehsil: z.string().trim().min(2, 'Choose the tehsil.').max(80),
  town: z.string().trim().min(2, 'Choose the tehsil.').max(80),
  /* Structured the way Airbnb's address confirm step collects it. Composed
     into one `fullAddress` string for storage/display (see toFullAddress
     below) rather than adding per-field DB columns — draft_data is a
     schemaless JSONB blob, so these just become new keys inside it. */
  flatNumber: z.string().trim().max(60).optional().or(z.literal('')),
  streetAddress: z.string().trim().min(3, 'Give the street address.'),
  landmark: z.string().trim().max(120).optional().or(z.literal('')),
  locality: z.string().trim().max(120).optional().or(z.literal('')),
  city: z.string().trim().min(2, 'Give the city/town.'),
  state: z.literal(HIMACHAL_PRADESH),
  pincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter a 6-digit PIN code.'),
  /* The pin is checked against the device-reported location of every photo and
     the walkthrough video (capture.util.ts), so it has to be the real spot even though guests see it offset. The
     range here is a cheap first filter; being inside Himachal Pradesh itself
     is enforced by assertLocationIsValid. */
  lat: z.number({ message: 'Drop the pin on the property.' }).min(30).max(34, 'Drop the pin on the property.'),
  lng: z.number({ message: 'Drop the pin on the property.' }).min(74).max(80, 'Drop the pin on the property.'),
});

/** Composes the structured address fields into the single string the rest
 *  of the app (listing cards, the detail page's fullLocation) displays. */
export function toFullAddress(a: {
  flatNumber?: string;
  streetAddress: string;
  landmark?: string;
  locality?: string;
  city: string;
  state: string;
  pincode: string;
}): string {
  return [a.flatNumber, a.streetAddress, a.landmark, a.locality, a.city, a.state, a.pincode]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(', ');
}

export const descriptionSchema = z.object({
  description: z
    .string()
    .trim()
    .min(120, 'Write at least 120 characters — this is the main thing a tenant reads.')
    .max(2000, 'Keep it under 2000 characters.'),
  theSpace: z.string().trim().max(1000).optional().or(z.literal('')),
  guestAccess: z.string().trim().max(1000).optional().or(z.literal('')),
});

export const ROOM_IDS = ['exterior', 'living', 'bedroom', 'kitchen', 'bath', 'view'] as const;

export const photoSchema = z.object({
  url: z.string().url(),
  room: z.enum(ROOM_IDS),
});

export const photosSchema = z.object({
  photos: z.array(photoSchema).min(5, 'Add at least 5 photographs of the property.'),
});

export const pricingSchema = z.object({
  dailyBaseRate: z.preprocess(
    parseRupees,
    z.number().int().min(500, 'Daily rate must be at least ₹500.').max(100000)
  ),
  weeklyDiscountPct: z.coerce.number().int().min(0).max(99),
  monthlyDiscountPct: z.coerce.number().int().min(0).max(99),
  minDays: z.coerce.number().int().min(1).max(365),
  availableFrom: z.string().min(10, 'Pick the first date the home is free.'),
  billsIncluded: z.enum(['all', 'electricity_extra', 'none']),
});

export const rulesSchema = z.object({
  checkIn: z.string().trim().min(3),
  checkOut: z.string().trim().min(3),
  pets: z.boolean(),
  smoking: z.boolean(),
  cancellation: z.enum(['flexible', 'moderate', 'firm']),
});

export const listingSchema = basicsSchema
  .merge(locationSchema)
  .merge(descriptionSchema)
  .merge(photosSchema)
  .merge(pricingSchema)
  .merge(rulesSchema)
  .extend({
    categories: z
      .array(z.string())
      .min(1, 'Pick at least one — this decides where guests find you.'),
    amenities: z.array(z.string()).min(3, 'Pick at least three amenities.'),
  });

export type ListingDraft = z.infer<typeof listingSchema>;

export const kindSchema = z.object({
  host_kind: z.enum(['individual', 'business']),
});

export const identitySchema = z.object({
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Enter a valid 10-character PAN.'),
  gst: z
    .string()
    .trim()
    .toUpperCase()
    .length(15, 'GSTIN is 15 characters.')
    .optional()
    .or(z.literal('')),
});

export const telemetrySchema = z.object({
  /* Client-set tick, not trusted on its own: what the server stores is decided
     by resolveWalkthrough (host-listings.service.ts) from a receipt or from
     what is already on the listing. It is kept as a required literal so a form
     with no walkthrough fails with a clear message before any of that runs. */
  walkthroughPassed: z.literal(true, { message: 'Record the walkthrough video with the camera before submitting.' }),
  /* The server-issued receipt from POST media/walkthrough
     (HostListingsService.verifyWalkthroughVideo): it names exactly which pin
     the recording was checked against. Optional because a host who edits a
     listing without recording again has no fresh receipt — the walkthrough
     already stored on the listing is kept instead (and re-measured against
     the pin). Without a receipt AND without a stored walkthrough, submit
     fails regardless of what walkthroughPassed says. */
  walkthroughToken: z.string().uuid('Record the walkthrough video again before submitting.').optional(),
  /* Display-only and never stored from here: the video URL saved with the
     listing is the one the server put in the receipt. */
  walkthroughVideoUrl: z.string().url().optional(),
});

export const mediaSchema = z.object({
  videoUrl: z.string().url().optional().or(z.literal('')),
  tourUrl: z.string().url().optional().or(z.literal('')),
});

export const hostKycSchema = kindSchema.merge(identitySchema);

export type HostKycPayload = z.infer<typeof hostKycSchema>;

/* The one-page listing form (submit-full / resubmit). Identity/host-type
   are NOT part of it — those come from the verified profile server-side.
   Payout details (bankingSchema) are not part of it either: every listing pays out to the
   host's one verified account (users.bank_account_number/bank_ifsc via the
   account-level bank-verification flow, gated by assertVerified), never a
   per-listing UPI/name the host retyped and that was never cross-checked
   against anything real. */
export const fullOnboardingSchema = listingSchema
  .merge(telemetrySchema)
  .merge(mediaSchema);

export type FullOnboardingDraft = z.infer<typeof fullOnboardingSchema>;
