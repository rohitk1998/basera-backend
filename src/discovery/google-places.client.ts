import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BLOCKED_NO_KEY, DESTINATION_CENTERS, SOURCE_GOOGLE, SOURCE_GOOGLE_DRYRUN } from './discovery.constants';
import { DiscoveryUsageService } from './discovery-usage.service';

export const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
/** Minimal mask. displayName is requested only for transient in-memory heuristics and is never persisted. */
// The phone fields are requested ONLY to learn whether the place has a number (owners we cannot call are skipped).
// The number itself is dropped in parse() and never stored or logged.
export const FIELD_MASK = 'places.id,places.location,places.types,places.displayName,places.nationalPhoneNumber,places.internationalPhoneNumber,nextPageToken';
const MAX_RETRIES = 4;
const BREAKER_MS = 15 * 60_000;
export const DRY_RUN_TOTAL_PER_QUERY = 15;
export const DRY_RUN_PAGE_SIZE = 10;

export class PlacesBlockedError extends Error {}
export class PlacesBudgetExhaustedError extends Error {
  constructor() {
    super('daily request budget exhausted');
  }
}

export interface PlaceCandidate {
  id: string;
  lat: number;
  lng: number;
  types: string[];
  /** Transient only: never write this anywhere. */
  displayName?: string;
  /** Whether Google lists a phone number. Only this yes/no is kept; the number is never stored. */
  hasPhone?: boolean;
}
export interface PlaceDetails {
  name: string | null;
  address: string | null;
  rating: number | null;
  ratingCount: number | null;
  mapsUrl: string | null;
  photoName: string | null;
  /** Up to 10 (Google's hard limit per place). */
  photoNames: string[];
  summary: string | null;
  amenities: string[];
  /** Google returns at most 5. Shown with author attribution, never mixed with our own reviews. */
  reviews: Array<{ author: string; authorUri: string | null; photoUri: string | null; reviewUri: string | null; rating: number | null; text: string; when: string }>;
}
export interface PlacesPage {
  places: PlaceCandidate[];
  nextPageToken?: string;
}
export interface SearchRequest {
  textQuery: string;
  destination: string;
  pageToken?: string;
  /** Hard daily budget for this source; enforced before every HTTP attempt. */
  budget: number;
}
export interface ClientDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

@Injectable()
export class GooglePlacesClient {
  private readonly logger = new Logger(GooglePlacesClient.name);
  private breakerUntil = 0;
  private deps: Required<ClientDeps>;

  constructor(
    private readonly usage: DiscoveryUsageService,
    @Optional() private readonly config?: ConfigService,
    @Optional() deps: ClientDeps = {},
  ) {
    this.deps = {
      fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: deps.random ?? Math.random,
      now: deps.now ?? Date.now,
    };
  }

  private env(key: string): string | undefined {
    const v = this.config?.get<string>(key) ?? process.env[key];
    return v === undefined || v === '' ? undefined : String(v);
  }
  get dryRun(): boolean {
    return String(this.env('GOOGLE_PLACES_DRY_RUN') ?? '').toLowerCase() === 'true';
  }
  get apiKey(): string | undefined {
    return this.env('GOOGLE_PLACES_API_KEY');
  }
  /** Value stored in listings.discovery_source and used as the usage counter key. */
  get sourceKey(): string {
    return this.dryRun ? SOURCE_GOOGLE_DRYRUN : SOURCE_GOOGLE;
  }
  /** null when usable, otherwise the reason it is blocked. */
  blockedReason(): string | null {
    if (this.dryRun) return null;
    if (!this.apiKey) return BLOCKED_NO_KEY;
    if (this.deps.now() < this.breakerUntil) return 'blocked: circuit breaker open after a 403/quota error from Google';
    return null;
  }

  async searchText(req: SearchRequest): Promise<PlacesPage> {
    const blocked = this.blockedReason();
    if (blocked) throw new PlacesBlockedError(blocked);
    if (this.dryRun) {
      if (!(await this.usage.reserve(this.sourceKey, req.budget))) throw new PlacesBudgetExhaustedError();
      return this.dryPage(req);
    }
    const center = DESTINATION_CENTERS[req.destination.toLowerCase()];
    const body: Record<string, unknown> = { textQuery: req.textQuery, pageSize: 20, regionCode: 'IN' };
    if (center) body.locationBias = { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: center.radiusM } };
    if (req.pageToken) body.pageToken = req.pageToken;

    let lastErr = 'unknown error';
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Budget is checked and consumed BEFORE each attempt, retries included.
      if (!(await this.usage.reserve(this.sourceKey, req.budget))) throw new PlacesBudgetExhaustedError();
      let res: Response;
      try {
        res = await this.deps.fetch(PLACES_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey!, 'X-Goog-FieldMask': FIELD_MASK },
          body: JSON.stringify(body),
        });
      } catch (e: any) {
        lastErr = `network error: ${e?.message ?? e}`;
        await this.usage.recordError(this.sourceKey, lastErr);
        await this.backoff(attempt);
        continue;
      }
      if (res.ok) return this.parse(await res.json());
      const text = await res.text().catch(() => '');
      lastErr = `Google Places HTTP ${res.status}`;
      await this.usage.recordError(this.sourceKey, `${lastErr} ${text.slice(0, 200)}`);
      if (res.status === 403 || (/RESOURCE_EXHAUSTED|quota/i.test(text) && res.status !== 429)) {
        this.breakerUntil = this.deps.now() + BREAKER_MS;
        throw new PlacesBlockedError(`blocked: ${lastErr} (circuit breaker opened for 15 min)`);
      }
      if (res.status === 429 || res.status >= 500) {
        await this.backoff(attempt);
        continue;
      }
      throw new Error(lastErr); // other 4xx: not retryable
    }
    throw new Error(`${lastErr} after ${MAX_RETRIES + 1} attempts`);
  }

  /** Live display data for ONE place. Never persist the result (Google terms); callers may keep it in memory only briefly. */
  async getDetails(placeId: string, budget: number, signal?: AbortSignal): Promise<PlaceDetails | null> {
    if (this.blockedReason() || this.dryRun) return null;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(placeId)) return null;
    if (!(await this.usage.reserve(`${this.sourceKey}_details`, budget))) return null;
    try {
      const res = await this.deps.fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
        ...(signal ? { signal } : {}),
        headers: { 'X-Goog-Api-Key': this.apiKey!, 'X-Goog-FieldMask': 'displayName,formattedAddress,rating,userRatingCount,googleMapsUri,photos.name,reviews,editorialSummary,generativeSummary,allowsDogs,goodForChildren,goodForGroups,parkingOptions,servesBreakfast,servesBrunch,servesDinner,accessibilityOptions,outdoorSeating,restroom,paymentOptions' },
      });
      if (!res.ok) {
        await this.usage.recordError(`${this.sourceKey}_details`, `Place details HTTP ${res.status}`);
        return null;
      }
      const j: any = await res.json();
      return {
        name: j.displayName?.text ?? null,
        address: j.formattedAddress ?? null,
        rating: typeof j.rating === 'number' ? j.rating : null,
        ratingCount: typeof j.userRatingCount === 'number' ? j.userRatingCount : null,
        mapsUrl: j.googleMapsUri ?? null,
        photoName: j.photos?.[0]?.name ?? null,
        summary: j.editorialSummary?.text ?? j.generativeSummary?.overview?.text ?? null,
        amenities: [
          j.allowsDogs === true && 'Pets allowed',
          j.goodForChildren === true && 'Good for children',
          j.goodForGroups === true && 'Good for groups',
          (j.parkingOptions?.freeParkingLot || j.parkingOptions?.freeStreetParking || j.parkingOptions?.freeGarageParking) && 'Free parking',
          !(j.parkingOptions?.freeParkingLot || j.parkingOptions?.freeStreetParking || j.parkingOptions?.freeGarageParking) &&
            (j.parkingOptions?.paidParkingLot || j.parkingOptions?.paidStreetParking || j.parkingOptions?.valetParking || j.parkingOptions?.paidGarageParking) && 'Parking available',
          j.servesBreakfast === true && 'Breakfast available',
          j.servesBrunch === true && 'Brunch available',
          j.servesDinner === true && 'Dinner available',
          j.accessibilityOptions?.wheelchairAccessibleEntrance === true && 'Step-free entrance',
          j.accessibilityOptions?.wheelchairAccessibleParking === true && 'Accessible parking',
          j.accessibilityOptions?.wheelchairAccessibleRestroom === true && 'Accessible restroom',
          j.restroom === true && 'Restroom',
          j.outdoorSeating === true && 'Outdoor seating',
          (j.paymentOptions?.acceptsCreditCards === true || j.paymentOptions?.acceptsDebitCards === true) && 'Cards accepted',
          j.paymentOptions?.acceptsCashOnly === true && 'Cash only',
        ].filter(Boolean) as string[],
        reviews: Array.isArray(j.reviews)
          ? j.reviews.slice(0, 5).map((r: any) => ({
              author: r.authorAttribution?.displayName ?? 'Google user',
              authorUri: r.authorAttribution?.uri ?? null,
              photoUri: typeof r.authorAttribution?.photoUri === 'string' && /^https:\/\/[a-z0-9.-]*googleusercontent\.com\//.test(r.authorAttribution.photoUri) ? r.authorAttribution.photoUri : null,
              reviewUri: typeof r.googleMapsUri === 'string' && r.googleMapsUri.startsWith('https://') ? r.googleMapsUri : null,
              rating: typeof r.rating === 'number' ? r.rating : null,
              text: String(r.text?.text ?? r.originalText?.text ?? ''),
              when: String(r.relativePublishTimeDescription ?? ''),
            }))
          : [],
        photoNames: Array.isArray(j.photos) ? j.photos.map((x: any) => x?.name).filter(Boolean).slice(0, 10) : [],
      };
    } catch (e: any) {
      await this.usage.recordError(`${this.sourceKey}_details`, `network error: ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * Owner contact for ONE place, for staff only (the admin inquiry screen). Fetched live on demand and returned to the
   * caller; never cached, stored or logged, and never exposed on any public endpoint.
   */
  async getContact(placeId: string, budget: number): Promise<{ name: string | null; address: string | null; phone: string | null; mapsUrl: string | null } | null> {
    if (this.blockedReason() || this.dryRun) return null;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(placeId)) return null;
    if (!(await this.usage.reserve(`${this.sourceKey}_details`, budget))) return null;
    try {
      const res = await this.deps.fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
        headers: { 'X-Goog-Api-Key': this.apiKey!, 'X-Goog-FieldMask': 'displayName,formattedAddress,nationalPhoneNumber,internationalPhoneNumber,googleMapsUri' },
      });
      if (!res.ok) {
        await this.usage.recordError(`${this.sourceKey}_details`, `Place contact HTTP ${res.status}`);
        return null;
      }
      const j: any = await res.json();
      return {
        name: j.displayName?.text ?? null,
        address: j.formattedAddress ?? null,
        phone: j.internationalPhoneNumber ?? j.nationalPhoneNumber ?? null,
        mapsUrl: typeof j.googleMapsUri === 'string' && j.googleMapsUri.startsWith('https://') ? j.googleMapsUri : null,
      };
    } catch (e: any) {
      await this.usage.recordError(`${this.sourceKey}_details`, `network error: ${e?.message ?? e}`);
      return null;
    }
  }

  /** Streams one photo through our server so the API key never reaches the browser. */
  private photoCache = new Map<string, { at: number; v: { body: Buffer; contentType: string } }>();
  private photoBytes = 0;
  private photoInflight = new Map<string, Promise<{ body: Buffer; contentType: string } | null>>();
  private static readonly PHOTO_TTL_MS = 30 * 60_000;
  private static readonly PHOTO_MAX_BYTES = 64 * 1024 * 1024;

  /** Photo bytes are held in memory 30 min (byte-capped LRU) and concurrent requests share one fetch, so one photo costs one budget unit per window. */
  async getPhoto(photoName: string, budget: number): Promise<{ body: Buffer; contentType: string } | null> {
    if (this.blockedReason() || this.dryRun) return null;
    if (!/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(photoName)) return null;
    const hit = this.photoCache.get(photoName);
    if (hit) {
      if (Date.now() - hit.at < GooglePlacesClient.PHOTO_TTL_MS) {
        this.photoCache.delete(photoName);
        this.photoCache.set(photoName, hit); // refresh LRU position
        return hit.v;
      }
      this.photoCache.delete(photoName);
      this.photoBytes -= hit.v.body.length;
    }
    const running = this.photoInflight.get(photoName);
    if (running) return running;
    const p = this.fetchPhoto(photoName, budget)
      .then((v) => {
        if (v && v.body.length <= GooglePlacesClient.PHOTO_MAX_BYTES / 4) {
          this.photoCache.set(photoName, { at: Date.now(), v });
          this.photoBytes += v.body.length;
          while (this.photoBytes > GooglePlacesClient.PHOTO_MAX_BYTES && this.photoCache.size > 0) {
            const k = this.photoCache.keys().next().value as string;
            this.photoBytes -= this.photoCache.get(k)!.v.body.length;
            this.photoCache.delete(k);
          }
        }
        return v;
      })
      .finally(() => this.photoInflight.delete(photoName));
    this.photoInflight.set(photoName, p);
    return p;
  }

  private async fetchPhoto(photoName: string, budget: number): Promise<{ body: Buffer; contentType: string } | null> {
    if (!(await this.usage.reserve(`${this.sourceKey}_photos`, budget))) return null;
    try {
      const res = await this.deps.fetch(`https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=900`, {
        headers: { 'X-Goog-Api-Key': this.apiKey! },
      });
      if (!res.ok) return null;
      return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'image/jpeg' };
    } catch {
      return null;
    }
  }

  /** Exponential backoff with full-ish jitter: base 500ms * 2^attempt, +0-50%. */
  backoffMs(attempt: number): number {
    const base = 500 * 2 ** attempt;
    return Math.round(base + base * 0.5 * this.deps.random());
  }
  private backoff(attempt: number) {
    return attempt >= MAX_RETRIES ? Promise.resolve() : this.deps.sleep(this.backoffMs(attempt));
  }

  private parse(json: any): PlacesPage {
    const places: PlaceCandidate[] = [];
    for (const p of json?.places ?? []) {
      const lat = p?.location?.latitude;
      const lng = p?.location?.longitude;
      if (typeof p?.id !== 'string' || typeof lat !== 'number' || typeof lng !== 'number') continue;
      places.push({ id: p.id, lat, lng, types: Array.isArray(p.types) ? p.types : [], displayName: p.displayName?.text, hasPhone: Boolean(p.nationalPhoneNumber || p.internationalPhoneNumber) });
    }
    return { places, nextPageToken: json?.nextPageToken || undefined };
  }

  /** Deterministic fake results. Ids overlap across categories (like real data) so dedupe is exercised. */
  private dryPage(req: SearchRequest): PlacesPage {
    const start = req.pageToken?.startsWith('dry:') ? Number(req.pageToken.slice(4)) || 0 : 0;
    const offset = hash(req.textQuery) % 5;
    const c = DESTINATION_CENTERS[req.destination.toLowerCase()] ?? DESTINATION_CENTERS.manali;
    const places: PlaceCandidate[] = [];
    for (let i = start; i < Math.min(start + DRY_RUN_PAGE_SIZE, DRY_RUN_TOTAL_PER_QUERY); i++) {
      const n = offset + i;
      places.push({
        id: `dryrun_${slug(req.destination)}_${n}`,
        lat: c.lat + 0.004 * (n % 8) + 0.0001 * (n % 3),
        lng: c.lng + 0.004 * Math.floor(n / 8),
        types: ['lodging'],
        hasPhone: true,
      });
    }
    const next = start + DRY_RUN_PAGE_SIZE;
    return { places, nextPageToken: next < DRY_RUN_TOTAL_PER_QUERY ? `dry:${next}` : undefined };
  }
}
