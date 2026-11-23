import { ListingEntity } from '../entities';
import { effectiveMinStay } from '../common/domain';
import { Amenity, AmenityGroup, CategoryId, Listing, Photo, RoomId } from './listing.types';
import { toFullAddress } from './listing-schema';
import { isMeasuredYes } from './wifi-test.util';

const ROOMS: readonly RoomId[] = ['exterior', 'living', 'bedroom', 'kitchen', 'view'];

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

const rupee = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;

function pricingOf(p: Record<string, any>): Listing['pricing'] {
  const mode = ['included', 'per_unit', 'flat'].includes(p.electricityMode) ? p.electricityMode : undefined;
  return {
    weeklyPrice: rupee(p.weeklyPrice),
    monthlyPrice: rupee(p.monthlyPrice),
    securityDeposit: rupee(p.securityDeposit),
    electricityMode: mode,
    electricityCharge: rupee(p.electricityCharge),
    cleaningCharge: rupee(p.cleaningCharge),
    extraGuestFee: rupee(p.extraGuestFee),
    includedGuests: rupee(p.includedGuests),
    utilitiesIncluded: Array.isArray(p.utilitiesIncluded) ? p.utilitiesIncluded.filter((u: unknown) => typeof u === 'string') : [],
    bufferDays: Math.min(Math.max(rupee(p.bufferDays) ?? 0, 0), 3),
  };
}

export function rowToListing(row: ListingEntity): Listing {
  const draft = (row.draft_data as Record<string, any>) || {};
  const propStep = draft.property_details || draft.property || draft.basics || {};
  const addressStep = draft.address || draft.location || {};

  const title =
    propStep.title || addressStep.fullAddress || addressStep.line1 || `Mountain Stay (#${row.id.slice(0, 6)})`;

  const town =
    propStep.town || propStep.tehsil || addressStep.town || addressStep.city || propStep.district || '';
  const inPlace = town ? ` in ${town}` : '';

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
    propStep.amenities || ['Workspace', 'Kitchen', 'Hot water', 'Room heater']
  ).map((label: string, i: number) => ({
    id: `am-${i}`,
    label,
    group: AMENITY_GROUPS[label] || 'safety',
  }));

  const categories: CategoryId[] = Array.isArray(propStep.categories) ? propStep.categories : [];

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

    weeklyDiscountPct: propStep.weeklyDiscountPct ?? 15,
    monthlyDiscountPct: propStep.monthlyDiscountPct ?? 40,
    beds: propStep.beds || (propStep.bedrooms ? `${propStep.bedrooms} BHK` : '1 room · private bath'),
    propertyType: propStep.propertyType || 'cottage',
    term: `min ${effectiveMinStay(propStep.minDays || (propStep.minMonths ? propStep.minMonths * 30 : 0))} days`,
    minDays: effectiveMinStay(propStep.minDays || (propStep.minMonths ? propStep.minMonths * 30 : 0)),
    verified: row.status === 'live' && !row.is_discovered,
    trust: draft.trustScore ?? null,
    rating: null,
    reviewCount: null,
    photos,
    amenities,
    description:
      propStep.description ||
      `A verified long-stay home${inPlace}, approved by the RhenBasera team and let by the month. Direct payment to host.`,
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

    bookingEligible: row.booking_eligible === true,
    pricing: pricingOf(propStep),

    ...(isMeasuredYes(draft.wifi)
      ? { wifiMeasured: { downMbps: draft.wifi.downMbps, upMbps: draft.wifi.upMbps, testedAt: draft.wifi.testedAt } }
      : {}),
  };
}

/**
 * Stub for a Google-discovered row. Built only from our own derived columns: never Google text.
 * Renderers must check `discovered` before using any price, bed or availability field.
 */
/** Our own research data (draft_data.property_details), whitelisted and type-checked. Never Google content. */
function researchFields(row: ListingEntity) {
  const pd: any = (row.draft_data as any)?.property_details;
  const pos = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const pct = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 90 ? v : 0);
  if (!pd || typeof pd !== 'object') return { dailyBaseRate: 0, monthlyDiscountPct: 0, bedrooms: 0, bathrooms: 0, maxGuests: 0 };
  return {
    dailyBaseRate: pos(pd.dailyBaseRate),
    // Same default the facets use (and owner listings): 40% off a 30-day stay when none is recorded.
    monthlyDiscountPct: typeof pd.monthlyDiscountPct === 'number' ? pct(pd.monthlyDiscountPct) : 40,
    bedrooms: pos(pd.bedrooms),
    bathrooms: pos(pd.bathrooms),
    maxGuests: pos(pd.maxGuests),
  };
}

export function discoveredToListing(row: ListingEntity): Listing {
  const place = (row.disc_tehsil || row.disc_district || '').trim();
  const district = (row.disc_district || '').trim();
  const tehsil = (row.disc_tehsil || '').trim();
  const pdTitle = (row.draft_data as Record<string, any> | null)?.property_details?.title;
  const ownTitle = typeof pdTitle === 'string' && pdTitle.trim() ? pdTitle.trim().slice(0, 120) : '';
  const hasCoords = typeof row.disc_lat === 'number' && typeof row.disc_lng === 'number';
  return {
    id: row.id,
    discovered: true,
    verified: false,
    title: ownTitle || `Homestay in ${place}`,
    titleIsFallback: !ownTitle,
    town: place,
    district,
    tehsil,
    fullLocation: tehsil && district ? `${tehsil}, ${district}` : district || tehsil,
    coords: hasCoords ? { lat: row.disc_lat as number, lng: row.disc_lng as number } : null,
    photos: [],
    rating: null,
    reviewCount: null,
    ...researchFields(row),
    weeklyDiscountPct: 0,
    beds: '',
    propertyType: 'homestay',
    term: '',
    minDays: 0,
    trust: 0,
    amenities: [],
    description: '',
    availableFrom: '',
    billsIncluded: 'all',
    houseRules: { checkIn: '', checkOut: '', pets: false, smoking: false },
    cancellation: 'moderate',
    categories: [],
    placeId: row.external_place_id ?? undefined,
  } as Listing;
}
