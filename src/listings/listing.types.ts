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

  captureCheckPassed?: boolean;

  trust: number | null;

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

  availableFrom: string;
  billsIncluded: 'all' | 'electricity_extra' | 'none';

  videoUrl?: string;
  tourUrl?: string;
  houseRules: HouseRules;
  cancellation: 'flexible' | 'moderate' | 'firm';

  coords: { lat: number; lng: number } | null;
  categories: CategoryId[];

  /** Admin-enabled; when false the web shows "Enquire" instead of "Request to book". */
  bookingEligible?: boolean;
  /** Long-stay terms, absolute integer rupees. Absent when the host did not set them. */
  pricing?: {
    weeklyPrice?: number;
    monthlyPrice?: number;
    securityDeposit?: number;
    electricityMode?: 'included' | 'per_unit' | 'flat';
    electricityCharge?: number;
    cleaningCharge?: number;
    extraGuestFee?: number;
    includedGuests?: number;
    utilitiesIncluded: string[];
    bufferDays: number;
  };

  wifiMeasured?: { downMbps: number; upMbps: number; testedAt: string };

  /** True only for Google-discovered, unclaimed stays shown on the unified grid. Check before using price/bed/availability. */
  discovered?: boolean;
  /** True while `title` is our generic "Homestay in <place>" rather than a live Google name. */
  titleIsFallback?: boolean;
  /** Internal: Google place id used for hydration. Stripped before the response leaves the controller. */
  placeId?: string;
  /** Discovered stubs only: our own derived district and tehsil. */
  district?: string;
  tehsil?: string;
};

export type Town = {
  name: string;

  from: number;

  total: number;
  listings: Listing[];
};
