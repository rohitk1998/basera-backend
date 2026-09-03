// Ported from web/lib/listings.ts (Listing/CategoryId/Photo/Amenity/HouseRules
// types only — the mock catalogue itself is dropped, see listings.service.ts).

export type CategoryId = 'long' | 'entire' | 'work' | 'views' | 'quiet';

export type RoomId = 'exterior' | 'living' | 'bedroom' | 'kitchen' | 'bath' | 'view';

export type Photo = { url: string; room: RoomId; caption?: string };

export type AmenityGroup =
  | 'scenic'
  | 'bathroom'
  | 'bedroom'
  | 'kitchen'
  | 'work'
  | 'safety'
  | 'outside';

export type Amenity = { id: string; label: string; group: AmenityGroup };

export type HouseRules = {
  checkIn: string;
  checkOut: string;
  pets: boolean;
  smoking: boolean;
  quietHours?: string;
};

export type Listing = {
  id: string;
  title: string;
  town: string;
  fullLocation: string;
  dailyBaseRate: number;
  weeklyDiscountPct: number;
  monthlyDiscountPct: number;
  beds: string;
  propertyType: 'cottage' | 'flat' | 'studio' | 'homestay' | 'cabin';
  term: string;
  minDays: number;
  verified: boolean;
  /** null when no verification data exists yet — never a placeholder number. */
  trust: number | null;
  /** null until there are real reviews. There is no reviews table, so any
   *  number here for a host-submitted listing would be invented. */
  rating: number | null;
  reviewCount: number | null;
  photos: Photo[];
  amenities: Amenity[];
  description: string;
  theSpace?: string;
  guestAccess?: string;
  neighbourhood?: string[];
  bedrooms: number;
  bathrooms: number;
  maxGuests: number;
  /** ISO date — the floor for the availability calendar. */
  availableFrom: string;
  houseRules: HouseRules;
  cancellation: 'flexible' | 'moderate' | 'firm';
  /** HP Tourism Home Stay registration — Layer 1, shown publicly. null when
   *  the host has not supplied one; callers omit the line rather than print a
   *  placeholder certificate number. */
  hpRegistrationNo: string | null;
  /** Approximate location — used for the map view's pins. null when the host
   *  never dropped a pin, so the map can skip it instead of stacking every
   *  such listing on one default point. */
  coords: { lat: number; lng: number } | null;
  categories: CategoryId[];
};

export type Town = {
  name: string;
  /** Cheapest monthly rent currently listed in this town. */
  from: number;
  listings: Listing[];
};
