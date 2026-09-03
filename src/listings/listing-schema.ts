import { z } from 'zod';

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

export const basicsSchema = z.object({
  title: z
    .string()
    .trim()
    .min(4, 'Give the home a name — at least 4 characters.')
    .max(60, 'Keep the name under 60 characters.'),
  propertyType: z.enum(['cottage', 'flat', 'studio', 'homestay', 'cabin']),
  beds: z.enum(['Studio', '1BHK', '2BHK', '3BHK']),
  bedrooms: z.coerce.number().int().min(0).max(10),
  bathrooms: z.coerce.number().int().min(1, 'At least one bathroom.').max(10),
  maxGuests: z.coerce.number().int().min(1, 'At least one guest.').max(20),
});

export const locationSchema = z.object({
  town: z.enum(['Dharamshala', 'Old Manali', 'Bir', 'Kasol', 'Palampur']),
  fullAddress: z
    .string()
    .trim()
    .min(10, 'Give the full address — it stays private until a booking is confirmed.'),
  /* The pin is checked against the walkthrough video's GPS at the next step,
     so it has to be the real spot even though guests see it offset. */
  lat: z.number().min(30).max(34, 'Drop the pin on the property.'),
  lng: z.number().min(74).max(80, 'Drop the pin on the property.'),
});

export const descriptionSchema = z.object({
  description: z
    .string()
    .trim()
    .min(120, 'Write at least 120 characters — this is the main thing a tenant reads.')
    .max(2000, 'Keep it under 2000 characters.'),
  theSpace: z.string().trim().max(1000).optional().or(z.literal('')),
  guestAccess: z.string().trim().max(1000).optional().or(z.literal('')),
});

export const photosSchema = z.object({
  photoCount: z.number().int().min(1, 'Add a photograph of the property.'),
});

export const pricingSchema = z.object({
  price: z.preprocess(
    parseRupees,
    z.number().int().min(1000, 'Monthly rent must be at least ₹1,000.').max(500000),
  ),
  minMonths: z.coerce.number().int().min(1).max(24),
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

/* Photographs and amenities are gathered on their own steps, so gating them
   here rejected a draft the host had filled in correctly — `photoCount: 0`
   is a real value, so an action's `?? 5` fallback never fired and the
   schema failed on 0 < 5. Kept exactly as-is. */
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
  });

export const publishSchema = listingSchema.extend({
  amenities: z.array(z.string()).min(3, 'List at least three amenities.'),
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

export const legalSchema = z.object({
  registrationNumber: z
    .string()
    .trim()
    .regex(/^HP\/HS\/\d{3,5}\/\d{4}$/i, 'Format: HP/HS/1234/2025.'),
});

export const telemetrySchema = z.object({
  walkthroughPassed: z.literal(true),
});

export const bankingSchema = z.object({
  upi: z.string().trim().regex(/^[\w.+-]+@[\w.-]+$/, 'Enter a valid UPI ID.'),
  name: z
    .string()
    .trim()
    .min(3, 'Enter the name exactly as your bank has it.'),
});

export const planSchema = z.object({
  plan: z.enum(['listed', 'featured', 'pro']),
});

export const hostKycSchema = kindSchema.merge(identitySchema).merge(legalSchema);

export type HostKycPayload = z.infer<typeof hostKycSchema>;

/* The one-page listing form (submit-full / resubmit). Identity/legal/host-type
   are NOT part of it — those come from the verified profile server-side. */
export const fullOnboardingSchema = listingSchema
  .merge(telemetrySchema)
  .merge(bankingSchema)
  .merge(planSchema);

export type FullOnboardingDraft = z.infer<typeof fullOnboardingSchema>;
