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

  wifiMeasured?: { downMbps: number; upMbps: number; testedAt: string };
};

export type Town = {
  name: string;

  from: number;

  total: number;
  listings: Listing[];
};
