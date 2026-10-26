import { ListingEntity } from '../entities';
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

    ...(isMeasuredYes(draft.wifi)
      ? { wifiMeasured: { downMbps: draft.wifi.downMbps, upMbps: draft.wifi.upMbps, testedAt: draft.wifi.testedAt } }
      : {}),
  };
}
