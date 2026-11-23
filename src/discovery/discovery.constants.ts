export const SOURCE_GOOGLE = 'google_places';
export const SOURCE_GOOGLE_DRYRUN = 'google_places_dryrun';
export const SOURCE_HOST_AUTHORIZED = 'host_authorized';
export const SOURCE_LICENSED = 'licensed';

export const BLOCKED_NO_KEY = 'blocked: GOOGLE_PLACES_API_KEY not configured';
export const DUPLICATE_DISTANCE_M = 40;
export const MAX_PAGES_PER_QUERY = 3;

export const DISCOVERY_STATES = [
  'DISCOVERED',
  'REVIEW_PENDING',
  'ELIGIBLE_FOR_OUTREACH',
  'CONTACT_IN_PROGRESS',
  'HOST_INTERESTED',
  'HOST_DECLINED',
  'CONVERTED_TO_PROPERTY',
  'ARCHIVED',
] as const;
export type DiscoveryState = (typeof DISCOVERY_STATES)[number];

/** Allowed next states per current state. CONVERTED_TO_PROPERTY is terminal and is only set by the claim flow. */
export const TRANSITIONS: Record<DiscoveryState, readonly DiscoveryState[]> = {
  DISCOVERED: ['REVIEW_PENDING', 'ARCHIVED'],
  REVIEW_PENDING: ['ELIGIBLE_FOR_OUTREACH', 'DISCOVERED', 'ARCHIVED'],
  ELIGIBLE_FOR_OUTREACH: ['CONTACT_IN_PROGRESS', 'REVIEW_PENDING', 'ARCHIVED'],
  CONTACT_IN_PROGRESS: ['HOST_INTERESTED', 'HOST_DECLINED', 'ELIGIBLE_FOR_OUTREACH', 'ARCHIVED'],
  HOST_INTERESTED: ['CONVERTED_TO_PROPERTY', 'HOST_DECLINED', 'CONTACT_IN_PROGRESS', 'ARCHIVED'],
  HOST_DECLINED: ['REVIEW_PENDING', 'ARCHIVED'],
  CONVERTED_TO_PROPERTY: [],
  ARCHIVED: ['DISCOVERED'],
};

export function isDiscoveryState(v: unknown): v is DiscoveryState {
  return typeof v === 'string' && (DISCOVERY_STATES as readonly string[]).includes(v);
}

export function canTransition(from: string, to: string): boolean {
  return isDiscoveryState(from) && isDiscoveryState(to) && TRANSITIONS[from].includes(to);
}

/** Approximate centres used for the location bias and dry-run coordinates. */
export const DESTINATION_CENTERS: Record<string, { lat: number; lng: number; radiusM: number }> = {
  manali: { lat: 32.2396, lng: 77.1887, radiusM: 12_000 },
  naggar: { lat: 32.1136, lng: 77.1752, radiusM: 6_000 },
  kasol: { lat: 32.0099, lng: 77.3147, radiusM: 6_000 },
  jibhi: { lat: 31.6, lng: 77.3, radiusM: 6_000 },
  'tirthan valley': { lat: 31.6, lng: 77.4, radiusM: 10_000 },
  bir: { lat: 32.0431, lng: 76.7192, radiusM: 8_000 },
  dharamshala: { lat: 32.219, lng: 76.3234, radiusM: 12_000 },
  khajjiar: { lat: 32.5527, lng: 76.0597, radiusM: 6_000 },
  sangla: { lat: 31.4231, lng: 78.2547, radiusM: 10_000 },
  kalpa: { lat: 31.5398, lng: 78.2587, radiusM: 8_000 },
  kaza: { lat: 32.2257, lng: 78.0716, radiusM: 10_000 },
  sethan: { lat: 32.3, lng: 77.13, radiusM: 6_000 },
  'pangi valley': { lat: 33.05, lng: 76.45, radiusM: 30_000 },
  'sach pass': { lat: 32.75, lng: 76.4, radiusM: 15_000 },
  'janjehli - karsog - chindi': { lat: 31.5, lng: 77.2, radiusM: 25_000 },
  'bharmour - kugti region': { lat: 32.44, lng: 76.53, radiusM: 20_000 },
  'pabbar valley - rohru - chanshal pass': { lat: 31.2, lng: 77.75, radiusM: 25_000 },
  'sainj valley': { lat: 31.7, lng: 77.35, radiusM: 12_000 },
  'miyar valley': { lat: 32.77, lng: 76.65, radiusM: 20_000 },
  'lahaul region': { lat: 32.57, lng: 77.03, radiusM: 40_000 },
  'churah region': { lat: 32.6, lng: 76.0, radiusM: 25_000 },
  'kotkhai - apple country': { lat: 31.1, lng: 77.55, radiusM: 15_000 },
  'rupi - bhaba region, kinnaur': { lat: 31.6, lng: 78.3, radiusM: 25_000 },
  'thachi valley': { lat: 31.55, lng: 77.0, radiusM: 12_000 },
};

/** Place types we accept as lodging; anything else returned by a text search is skipped. */
export const LODGING_TYPES = new Set([
  'lodging', 'guest_house', 'bed_and_breakfast', 'cottage', 'farmstay', 'camping_cabin', 'private_guest_room',
]);

/** Homestays only: a place carrying ANY of these types is skipped even when it also says generic `lodging`. */
export const EXCLUDED_TYPES = new Set(['hotel', 'resort_hotel', 'motel', 'extended_stay_hotel', 'hostel', 'inn', 'japanese_inn', 'campground']);

/** Google labels many genuine homestays `hotel`; a homestay-style NAME overrides an excluded type. */
export const HOMESTAY_NAME = /home\s?-?stay|guest\s?house|cottage|b\s?&\s?b|bed\s?(and|&)\s?breakfast|farm\s?stay|\bvilla\b|\bhouse\b|\bhome\b|\bcabin\b|\bcamp\b/i;

/** Licence rules per data source. Fixed text, read-only: shown on the admin Discovery screen. */
export const DISCOVERY_SOURCES = [
  {
    key: 'google_places', name: 'Google Places API (New)', allows_storage: false, attribution_required: true, retention_days: 30,
    license_notes: 'Store Place ID, lat/lng and our own operational metadata only. Names, photos, reviews, ratings, phone and descriptions must be fetched live and shown with attribution. Place IDs should be refreshed at least every 12 months. Re-check Google Maps Platform terms before launch.',
  },
  {
    key: 'google_places_dryrun', name: 'Google Places (dry-run fake data)', allows_storage: true, attribution_required: false, retention_days: 1,
    license_notes: 'Deterministic fake Place IDs for tests/dev only. Never real inventory.',
  },
  {
    key: 'host_authorized', name: 'Host-authorised submission', allows_storage: true, attribution_required: false, retention_days: null,
    license_notes: 'The host supplied this data and consented to its use; full storage permitted.',
  },
  {
    key: 'licensed', name: 'Licensed dataset', allows_storage: true, attribution_required: false, retention_days: null,
    license_notes: 'Third-party dataset under a licence that permits storage; record the licence terms per import.',
  },
] as const;
