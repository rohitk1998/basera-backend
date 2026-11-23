import { z } from 'zod';
import { HP_DISTRICTS } from './hp-locations';
import { MIN_STAY_NIGHTS } from '../common/domain';

export const parseRupees = (v: unknown) => {
  if (typeof v === 'number') return Math.round(v);
  const digits = String(v ?? '').replace(/[^\d]/g, '');
  return digits ? Number.parseInt(digits, 10) : Number.NaN;
};

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
  district: z.enum(HP_DISTRICTS, { message: 'Choose the district.' }),
  tehsil: z.string().trim().min(2, 'Choose the tehsil.').max(80),
  town: z.string().trim().min(2, 'Choose the tehsil.').max(80),

  flatNumber: z.string().trim().max(60).optional().or(z.literal('')),
  streetAddress: z.string().trim().min(3, 'Give the street address.'),
  landmark: z.string().trim().max(120).optional().or(z.literal('')),
  locality: z.string().trim().max(120).optional().or(z.literal('')),
  city: z.string().trim().min(2, 'Give the city/town.'),
  state: z.literal(HIMACHAL_PRADESH),
  pincode: z
    .string()
    .trim()
    .regex(/^17[1-7]\d{3}$/, 'Enter a Himachal Pradesh PIN code (171xxx–177xxx).'),

  lat: z.number({ message: 'Drop the pin on the property.' }).min(30).max(34, 'Drop the pin on the property.'),
  lng: z.number({ message: 'Drop the pin on the property.' }).min(74).max(80, 'Drop the pin on the property.'),
});

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

/** Blank / missing -> undefined; otherwise whole rupees (never a float). */
const optionalRupees = (max: number, label: string) =>
  z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : parseRupees(v)),
    z
      .number({ message: `Enter ${label} as a whole number of rupees.` })
      .int()
      .min(0, `${label} cannot be negative.`)
      .max(max, `${label} cannot be more than ₹${max.toLocaleString('en-IN')}.`)
      .optional(),
  );

export const UTILITIES = ['water', 'electricity', 'wifi', 'gas', 'housekeeping'] as const;
export const ELECTRICITY_MODES = ['included', 'per_unit', 'flat'] as const;

export const pricingSchema = z.object({
  dailyBaseRate: z.preprocess(
    parseRupees,
    z.number().int().min(500, 'Daily rate must be at least ₹500.').max(100000)
  ),
  weeklyDiscountPct: z.coerce.number().int().min(0).max(99),
  monthlyDiscountPct: z.coerce.number().int().min(0).max(99),
  minDays: z.coerce.number().int().min(MIN_STAY_NIGHTS).max(365),
  availableFrom: z.string().min(10, 'Pick the first date the home is free.'),
  billsIncluded: z.enum(['all', 'electricity_extra', 'none']),

  // Long-stay absolute prices (integer rupees). Optional; the discount percentages stay for back-compat.
  weeklyPrice: optionalRupees(700000, 'The weekly price'),
  monthlyPrice: optionalRupees(3000000, 'The monthly price'),
  securityDeposit: optionalRupees(500000, 'The security deposit'),
  electricityMode: z.enum(ELECTRICITY_MODES).optional(),
  electricityCharge: optionalRupees(10000, 'The electricity charge'),
  cleaningCharge: optionalRupees(20000, 'The cleaning charge'),
  extraGuestFee: optionalRupees(10000, 'The extra guest fee'),
  includedGuests: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.coerce.number().int().min(1, 'At least one guest is included.').max(20).optional(),
  ),
  utilitiesIncluded: z
    .array(z.enum(UTILITIES, { message: 'Unknown utility.' }))
    .max(UTILITIES.length)
    .refine((a) => new Set(a).size === a.length, 'List each utility once.')
    .default([]),
  bufferDays: z.coerce.number().int().min(0, 'Buffer is 0 to 3 days.').max(3, 'Buffer is 0 to 3 days.').default(0),
});

const BEDROOMS_FOR_SIZE: Record<string, number> = { Studio: 0, '1BHK': 1, '2BHK': 2, '3BHK': 3 };

const todayIso = (timeZone?: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export function clampPastAvailableFrom<T extends { availableFrom?: string }>(d: T, timeZone?: string): T {
  const today = todayIso(timeZone);
  if (d.availableFrom && /^\d{4}-\d{2}-\d{2}$/.test(d.availableFrom) && d.availableFrom < today) {
    return { ...d, availableFrom: today };
  }
  return d;
}

export function listingIssues(
  d: {
    beds?: string;
    bedrooms?: number | string;
    weeklyDiscountPct?: number | string;
    monthlyDiscountPct?: number | string;
    availableFrom?: string;
    dailyBaseRate?: number | string;
    weeklyPrice?: number | string;
    monthlyPrice?: number | string;
    electricityMode?: string;
    electricityCharge?: number | string;
    includedGuests?: number | string;
    maxGuests?: number | string;
  },
  opts: { timeZone?: string } = {},
): Partial<
  Record<
    | 'bedrooms'
    | 'weeklyDiscountPct'
    | 'availableFrom'
    | 'weeklyPrice'
    | 'monthlyPrice'
    | 'electricityCharge'
    | 'includedGuests',
    string
  >
> {
  const issues: Partial<
    Record<
      | 'bedrooms'
      | 'weeklyDiscountPct'
      | 'availableFrom'
      | 'weeklyPrice'
      | 'monthlyPrice'
      | 'electricityCharge'
      | 'includedGuests',
      string
    >
  > = {};
  const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  const daily = num(d.dailyBaseRate);
  const wp = num(d.weeklyPrice);
  const mp = num(d.monthlyPrice);
  if (daily !== undefined && Number.isFinite(daily)) {
    if (wp !== undefined && wp > daily * 7) {
      issues.weeklyPrice = `The weekly price cannot be more than 7 days at the daily rate (₹${(daily * 7).toLocaleString('en-IN')}).`;
    }
    if (mp !== undefined && mp > daily * 30) {
      issues.monthlyPrice = `The monthly price cannot be more than 30 days at the daily rate (₹${(daily * 30).toLocaleString('en-IN')}).`;
    }
  }
  if (!issues.monthlyPrice && wp !== undefined && mp !== undefined && mp / 30 > wp / 7) {
    issues.monthlyPrice = 'The monthly price per day cannot be higher than the weekly price per day.';
  }
  const ec = num(d.electricityCharge);
  if ((d.electricityMode === 'per_unit' || d.electricityMode === 'flat') && !(ec !== undefined && ec > 0)) {
    issues.electricityCharge = 'Enter the electricity charge, or choose "Included in the rent".';
  }
  const ig = num(d.includedGuests);
  const mg = num(d.maxGuests);
  if (ig !== undefined && mg !== undefined && ig > mg) {
    issues.includedGuests = 'Included guests cannot be more than the maximum guests.';
  }
  const expected = d.beds ? BEDROOMS_FOR_SIZE[d.beds] : undefined;
  if (expected !== undefined && d.bedrooms !== undefined && d.bedrooms !== '' && Number(d.bedrooms) !== expected) {
    issues.bedrooms =
      expected === 0
        ? 'A studio has no separate bedroom — enter 0, or pick a bigger size.'
        : `A ${d.beds} has ${expected} bedroom${expected === 1 ? '' : 's'} — enter ${expected}, or change the size.`;
  }
  const weekly = Number(d.weeklyDiscountPct);
  const monthly = Number(d.monthlyDiscountPct);
  if (Number.isFinite(weekly) && Number.isFinite(monthly) && weekly > monthly) {
    issues.weeklyDiscountPct = 'The weekly discount cannot be bigger than the monthly discount.';
  }
  if (d.availableFrom && /^\d{4}-\d{2}-\d{2}$/.test(d.availableFrom) && d.availableFrom < todayIso(opts.timeZone)) {
    issues.availableFrom = 'Pick today or a later date — the home cannot be available in the past.';
  }
  return issues;
}

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
  gst: z
    .string()
    .trim()
    .toUpperCase()
    .length(15, 'GSTIN is 15 characters.')
    .optional()
    .or(z.literal('')),
});

export const telemetrySchema = z.object({
  walkthroughPassed: z.literal(true, { message: 'Record the walkthrough video with the camera before submitting.' }),

  walkthroughToken: z.string().uuid('Record the walkthrough video again before submitting.').optional(),

  walkthroughVideoUrl: z.string().url().optional(),
});

export const wifiSchema = z.object({
  wifiAnswer: z.enum(['yes', 'no', 'later']).optional(),
  wifiTestToken: z.string().uuid('Run the Wi-Fi test again before submitting.').optional(),
});

export const mediaSchema = z.object({
  videoUrl: z.string().url().optional().or(z.literal('')),

  tourUrl: z
    .string()
    .trim()
    .max(500, 'Keep the tour link under 500 characters.')
    .url('Enter a valid tour link.')
    .refine((v) => /^https?:\/\//i.test(v), 'The tour link must start with http:// or https://.')
    .optional()
    .or(z.literal('')),
});

export const hostKycSchema = kindSchema.merge(identitySchema);

export type HostKycPayload = z.infer<typeof hostKycSchema>;

export const fullOnboardingSchema = listingSchema
  .merge(telemetrySchema)
  .merge(wifiSchema)
  .merge(mediaSchema);

export type FullOnboardingDraft = z.infer<typeof fullOnboardingSchema>;
