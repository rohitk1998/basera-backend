import { ListingEntity } from '../entities';
import { Amenity, AmenityGroup, CategoryId, Listing, Photo, RoomId } from './listing.types';

const ROOMS: readonly RoomId[] = ['exterior', 'living', 'bedroom', 'kitchen', 'view'];

// Mirrors web/lib/listings.ts COMMON_AMENITIES — same labels, same groups,
// so a host-picked amenity renders under the right heading on the detail page.
const AMENITY_GROUPS: Record<string, AmenityGroup> = {
  Wifi: 'work',
  Workspace: 'work',
  'Power backup': 'work',
  Kitchen: 'kitchen',
  'Dining table': 'kitchen',
  'Hot water': 'bathroom',
  'Room heater': 'bathroom',
  'Attached bathroom': 'bathroom',
  'Washing machine': 'bedroom',
  'Extra bedding': 'bedroom',
  'Mountain views': 'scenic',
  Balcony: 'scenic',
  Parking: 'outside',
  Garden: 'outside',
  'Smoke alarm': 'safety',
  'First aid kit': 'safety',
};

/**
 * Ported from web/lib/listing-mapper.ts rowToListing — the single row →
 * `Listing` mapper. This logic used to be copy-pasted into three places in
 * the Next.js app, which is how two bugs survived in all of them at once:
 *
 *   - `coords` was read from `draft.telemetry.coords`, but telemetrySchema is
 *     only `{ walkthroughPassed }`. lat/lng come from locationSchema and land
 *     in `property_details`, so every listing fell back to the same
 *     Dharamshala point and every map pin stacked there.
 *   - `hpRegistrationNo` was read as `registration_number` / `regNumber` /
 *     `hpTourismNumber`, but submit-full writes camelCase `registrationNumber`
 *     — so every listing displayed the placeholder 'HP/HS/LIVE/2026' as its
 *     government registration. It now returns null and callers omit the line;
 *     inventing a certificate number is worse than showing none.
 *
 * `rating` and `reviewCount` are null for real listings: there is no reviews
 * table, so any number here would be fabricated.
 */
export function rowToListing(row: ListingEntity): Listing {
  const draft = (row.draft_data as Record<string, any>) || {};
  const propStep = draft.property_details || draft.property || draft.basics || {};
  const addressStep = draft.address || draft.location || {};
  const legalStep = draft.legal || {};

  const title =
    propStep.title || addressStep.fullAddress || addressStep.line1 || `Mountain Stay (#${row.id.slice(0, 6)})`;
  const town = propStep.town || addressStep.town || addressStep.city || 'Dharamshala';

  // propStep.photos entries are { url, room } (photoSchema) — not bare URLs.
  const photos: Photo[] =
    propStep.photos && propStep.photos.length > 0
      ? propStep.photos.map((p: { url: string; room?: RoomId }, i: number) => ({
          url: p.url,
          room: p.room || ROOMS[i % ROOMS.length],
          caption: `${title} - Room view`,
        }))
      : Array.from({ length: 5 }, (_, i) => ({
          url: `https://picsum.photos/seed/stay-${row.id}-${i + 1}/900/700`,
          room: ROOMS[i % ROOMS.length],
          caption: `${title} - Room view`,
        }));

  const amenities: Amenity[] = (
    propStep.amenities || ['Wifi', 'Workspace', 'Kitchen', 'Hot water', 'Room heater']
  ).map((label: string, i: number) => ({
    id: `am-${i}`,
    label,
    group: AMENITY_GROUPS[label] || 'safety',
  }));

  const categories: CategoryId[] =
    propStep.categories && propStep.categories.length > 0 ? propStep.categories : ['long', 'work', 'views'];

  // lat/lng live in property_details (locationSchema), not telemetry.
  const lat = typeof propStep.lat === 'number' ? propStep.lat : draft.telemetry?.coords?.lat;
  const lng = typeof propStep.lng === 'number' ? propStep.lng : draft.telemetry?.coords?.lng;

  return {
    id: row.id,
    title,
    town,
    fullLocation: addressStep.fullAddress || propStep.fullAddress || `${title} in ${town}, Himachal Pradesh`,
    dailyBaseRate: propStep.dailyBaseRate || Math.round((propStep.price || propStep.monthlyRent || 12000) / 30),
    weeklyDiscountPct: propStep.weeklyDiscountPct || 15,
    monthlyDiscountPct: propStep.monthlyDiscountPct || 40,
    beds: propStep.beds || (propStep.bedrooms ? `${propStep.bedrooms} BHK` : '1 room · private bath'),
    propertyType: propStep.propertyType || 'cottage',
    term: propStep.minDays ? `min ${propStep.minDays} days` : 'min 1 day',
    minDays: propStep.minDays || (propStep.minMonths ? propStep.minMonths * 30 : 1),
    verified: row.status === 'live',
    trust: draft.trustScore ?? null,
    rating: null,
    reviewCount: null,
    photos,
    amenities,
    description:
      propStep.description ||
      `A verified long-stay home in ${town}, approved by the Basera team and let by the month. Direct payment to host.`,
    theSpace: propStep.theSpace || undefined,
    guestAccess: propStep.guestAccess || undefined,
    bedrooms: propStep.bedrooms || 1,
    bathrooms: propStep.bathrooms || 1,
    maxGuests: propStep.maxGuests || 2,
    availableFrom: propStep.availableFrom || new Date().toISOString().slice(0, 10),
    billsIncluded: propStep.billsIncluded || 'all',
    videoUrl: draft.media?.videoUrl || undefined,
    tourUrl: draft.media?.tourUrl || undefined,
    houseRules: {
      checkIn: propStep.checkIn || '12:00 pm – 9:00 pm',
      checkOut: propStep.checkOut || 'Before 11:00 am',
      pets: propStep.pets ?? false,
      smoking: propStep.smoking ?? false,
    },
    cancellation: propStep.cancellation || 'moderate',
    hpRegistrationNo: legalStep.registrationNumber || legalStep.registration_number || null,
    coords: typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null,
    categories,
  };
}
