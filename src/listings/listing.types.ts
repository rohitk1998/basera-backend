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
  | 'outside'
  | 'entertainment'
  | 'family';

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
  billsIncluded: 'all' | 'electricity_extra' | 'none';
  /** Optional walkthrough video / 3D tour, shown on the listing page when a
   *  host has provided one — see MediaExtras. */
  videoUrl?: string;
  tourUrl?: string;
  houseRules: HouseRules;
  cancellation: 'flexible' | 'moderate' | 'firm';
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
  /** Total live listings in this town — use this for any "N homes" count,
   *  NOT listings.length: `listings` below is a bounded preview (see
   *  ListingsService.getTownSummaries), not every listing in the town. */
  total: number;
  listings: Listing[];
};
