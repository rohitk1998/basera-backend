import { ListingEntity } from '../entities';
import { Amenity, AmenityGroup, CategoryId, Listing, Photo, RoomId } from './listing.types';
import { toFullAddress } from './listing-schema';

const ROOMS: readonly RoomId[] = ['exterior', 'living', 'bedroom', 'kitchen', 'view'];

// Mirrors web/lib/listings.ts COMMON_AMENITIES — same labels, same groups,
// so a host-picked amenity renders under the right heading on the detail page.
const AMENITY_GROUPS: Record<string, AmenityGroup> = {
  Wifi: 'work',
  Workspace: 'work',
  'Power backup': 'work',
  'Air conditioning': 'work',
  'Ceiling fan': 'work',
  Iron: 'work',
  Kitchen: 'kitchen',
  'Dining table': 'kitchen',
  Refrigerator: 'kitchen',
  Microwave: 'kitchen',
  'Electric kettle': 'kitchen',
  'Cooking basics': 'kitchen',
  'Dishes and cutlery': 'kitchen',
  'Hot water': 'bathroom',
  'Room heater': 'bathroom',
  'Attached bathroom': 'bathroom',
  'Hair dryer': 'bathroom',
  Shampoo: 'bathroom',
  Bathtub: 'bathroom',
  'Washing machine': 'bedroom',
  'Extra bedding': 'bedroom',
  Hangers: 'bedroom',
  'Blackout curtains': 'bedroom',
  'Clothes drying rack': 'bedroom',
  'Mountain views': 'scenic',
  Balcony: 'scenic',
  'Valley views': 'scenic',
  'Bonfire area': 'scenic',
  Parking: 'outside',
  Garden: 'outside',
  'EV charger': 'outside',
  Terrace: 'outside',
  'Smoke alarm': 'safety',
  'First aid kit': 'safety',
  'Fire extinguisher': 'safety',
  'CCTV (common areas)': 'safety',
  TV: 'entertainment',
  'Streaming services': 'entertainment',
  'Board games': 'entertainment',
  'Bluetooth speaker': 'entertainment',
  "Baby's crib": 'family',
  'High chair': 'family',
  'Board games for kids': 'family',
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
 * `rating` and `reviewCount` are null for real listings: there is no reviews
 * table, so any number here would be fabricated.
 */
export function rowToListing(row: ListingEntity): Listing {
  const draft = (row.draft_data as Record<string, any>) || {};
  const propStep = draft.property_details || draft.property || draft.basics || {};
  const addressStep = draft.address || draft.location || {};

  const title =
    propStep.title || addressStep.fullAddress || addressStep.line1 || `Mountain Stay (#${row.id.slice(0, 6)})`;
  // Never invent a place: a listing with no town/tehsil/city falls back to its
  // district, and to '' (shown as nothing) rather than to some other town.
  const town =
    propStep.town || propStep.tehsil || addressStep.town || addressStep.city || propStep.district || '';
  const inPlace = town ? ` in ${town}` : '';

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

  // Only the categories the host actually chose. This used to show
  // ['long', 'work', 'views'] when none were stored, but the category filter
  // (listings.service.ts, a jsonb containment check on the stored array) can
  // only match stored values — so a listing would display a "work" badge
  // that the "work" filter never returned.
  const categories: CategoryId[] = Array.isArray(propStep.categories) ? propStep.categories : [];

  // lat/lng live in property_details (locationSchema), not telemetry.
  const lat = typeof propStep.lat === 'number' ? propStep.lat : draft.telemetry?.coords?.lat;
  const lng = typeof propStep.lng === 'number' ? propStep.lng : draft.telemetry?.coords?.lng;

  return {
    id: row.id,
    title,
    town,
    fullLocation:
      (addressStep.streetAddress && toFullAddress(addressStep)) ||
      (propStep.streetAddress && toFullAddress(propStep)) ||
      addressStep.fullAddress ||
      propStep.fullAddress ||
      `${title}${inPlace}, Himachal Pradesh`,
    dailyBaseRate: propStep.dailyBaseRate || Math.round((propStep.price || propStep.monthlyRent || 12000) / 30),
    // `??`, not `||`: a host who chose 0% must get 0%, not the 15%/40% default.
    weeklyDiscountPct: propStep.weeklyDiscountPct ?? 15,
    monthlyDiscountPct: propStep.monthlyDiscountPct ?? 40,
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
      `A verified long-stay home${inPlace}, approved by the Basera team and let by the month. Direct payment to host.`,
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
    coords: typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null,
    categories,
  };
}
