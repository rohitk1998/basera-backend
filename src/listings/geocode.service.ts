import { partsFromGoogle, partsFromNominatim, type AddressParts } from './reverse-parts';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { distanceKm, districtCentre, isInsideHimachal, isTehsilOf } from './hp-locations';

export type GeocodePrecision = 'exact' | 'area' | 'tehsil' | 'district';

/** Where the answer came from; 'fallback' is the final district-centre guess. */
export type GeocodeSource = 'google' | 'osm' | 'fallback';

export interface GeocodeResult {
  lat: number;
  lng: number;
  /** How close the pin is to what the host described. */
  precision: GeocodePrecision;
  /** What to tell the host about it. */
  message: string;
  source: GeocodeSource;
}

export interface ReverseResult {
  /** Empty when no provider could read an address for the spot. */
  address: string;
  /** The address split into the pieces the listing form has fields for (any may be missing). */
  parts: AddressParts;
  source: 'google' | 'osm' | 'none';
}

type Point = { lat: number; lng: number };
/** A provider hit that passed validation, before it is turned into an answer. */
type Candidate = { point: Point; precision: 'exact' | 'area'; source: 'google' | 'osm' };

type GoogleBody = {
  status?: string;
  error_message?: string;
  results?: {
    formatted_address?: string;
    address_components?: { long_name?: string; short_name?: string; types?: string[] }[];
    types?: string[];
    geometry?: { location?: { lat?: number; lng?: number }; location_type?: string };
  }[];
};

type NominatimHit = {
  lat: string;
  lon: string;
  category?: string;
  type?: string;
  addresstype?: string;
};

// A result farther than this from its district's centre is a same-named place
// elsewhere, not the one the host meant. The largest districts reach ~120 km.
const MAX_KM_FROM_DISTRICT_CENTRE = 160;
const DEFAULT_GAP_BETWEEN_LOOKUPS_MS = 1100; // OpenStreetMap's usage policy: at most one request per second
const LOOKUP_TIMEOUT_MS = 8000;
const GOOGLE_TIMEOUT_MS = 6000;
const GOOGLE_BREAKER_MS = 5 * 60 * 1000; // after a denied key / exhausted quota, leave Google alone this long
const GOOGLE_DEFAULT_BASE = 'https://maps.googleapis.com';
const OSM_USER_AGENT = 'Basera/1.0 (verified long-stay rentals in Himachal Pradesh; host listing form)';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

// Hits that describe a whole region, not a spot a host could be standing on.
const BROAD_TYPES = new Set(['administrative', 'state', 'state_district', 'county', 'region', 'district', 'subdistrict']);

// Google: statuses that mean "the service is unusable right now" (vs. simply no match).
const GOOGLE_BREAKER_STATUSES = new Set(['REQUEST_DENIED', 'OVER_QUERY_LIMIT', 'OVER_DAILY_LIMIT']);
const GOOGLE_ERROR_STATUSES = new Set([...GOOGLE_BREAKER_STATUSES, 'INVALID_REQUEST', 'UNKNOWN_ERROR']);
// Google result types that name a spot a host could be standing on.
const GOOGLE_POINT_TYPES = new Set([
  'premise', 'subpremise', 'street_address', 'route', 'point_of_interest', 'establishment', 'neighborhood', 'sublocality',
  'sublocality_level_1', 'sublocality_level_2', 'sublocality_level_3', 'street_number', 'intersection', 'lodging', 'natural_feature',
]);
// Google result types that only name a region.
const GOOGLE_BROAD_TYPES = new Set([
  'administrative_area_level_1', 'administrative_area_level_2', 'administrative_area_level_3', 'administrative_area_level_4',
  'locality', 'country', 'political', 'colloquial_area', 'postal_code', 'postal_town',
]);

/** Removes any `key=...` from text headed for a log. */
const scrub = (text: string) => text.replace(/([?&\s]|^)key=[^&\s"']*/gi, '$1key=***');

/**
 * Turns "district + tehsil + what the host typed" into a map pin, getting as
 * close to the exact spot as the data allows: the exact place, else the area,
 * else the tehsil, else the centre of the district. It never fails outright —
 * when no provider can be reached the host still gets a pin to drag.
 *
 * Google's Geocoding API is asked first when a server key is configured, and
 * OpenStreetMap's Nominatim is the fallback whenever Google is unavailable or
 * unhelpful. A denied key or exhausted quota pauses Google for a few minutes so
 * it does not slow every request. Nominatim lookups are serialised to one per
 * second, identified with a User-Agent, and everything is cached, as the
 * OpenStreetMap usage policy asks.
 */
@Injectable()
export class GeocodeService {
  private readonly logger = new Logger(GeocodeService.name);
  private readonly baseUrl: string;
  private readonly minGapMs: number;
  private readonly googleKey: string;
  private readonly googleBase: string;
  private googlePausedUntil = 0;
  private readonly cache = new Map<string, { at: number; value: GeocodeResult | ReverseResult }>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastLookupAt = 0;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = (this.config.get<string>('NOMINATIM_BASE_URL') || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
    // Only tests shorten the pacing; production always keeps to the published policy.
    const gap = Number(this.config.get<string>('NOMINATIM_MIN_GAP_MS'));
    this.minGapMs = this.config.get<string>('NOMINATIM_BASE_URL') && Number.isFinite(gap) ? gap : DEFAULT_GAP_BETWEEN_LOOKUPS_MS;
    this.googleKey = (this.config.get<string>('GOOGLE_MAPS_SERVER_KEY') ?? '').trim();
    // Only tests point this elsewhere.
    this.googleBase = (this.config.get<string>('GOOGLE_GEOCODE_BASE_URL') || GOOGLE_DEFAULT_BASE).replace(/\/$/, '');
  }

  async locate(input: { district: string; tehsil: string; query?: string }): Promise<GeocodeResult> {
    const { district, tehsil } = input;
    const query = (input.query ?? '').trim().slice(0, 200);
    const centre = districtCentre(district);
    if (!centre || !isTehsilOf(district, tehsil)) {
      throw new BadRequestException('Choose a district and a tehsil that belongs to it.');
    }

    const key = `${district}|${tehsil}|${query}`.toLowerCase();
    const cached = this.recall<GeocodeResult>(key);
    if (cached) return cached;

    const value = await this.resolve(district, tehsil, query, centre);
    // Only remember answers that came from a real lookup; a fallback caused by a
    // network hiccup should be retried next time, not served for a day.
    if (value.source !== 'fallback') this.remember(key, value);
    return value;
  }

  /**
   * The street address of a pin, for showing it back to the host. Never throws
   * for a provider problem: an empty address means "could not read one".
   */
  async reverse(lat: number, lng: number): Promise<ReverseResult> {
    // TEST ONLY (CAPTURE_LOCATION_BYPASS): read the address of a pin outside the state too.
    const bypass = ['true', '1'].includes(String(this.config.get('CAPTURE_LOCATION_BYPASS')));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (!bypass && !isInsideHimachal(lat, lng))) {
      throw new BadRequestException('That spot is outside Himachal Pradesh.');
    }
    const key = `rev|${lat.toFixed(4)},${lng.toFixed(4)}`;
    const cached = this.recall<ReverseResult>(key);
    if (cached) return cached;

    const ctx = { googleDown: false };
    let value: ReverseResult | null = null;

    const body = await this.googleGet(new URLSearchParams({ latlng: `${lat},${lng}` }), ctx);
    const formatted = body?.results?.[0]?.formatted_address;
    if (typeof formatted === 'string' && formatted.trim()) {
      value = { address: formatted.trim(), parts: partsFromGoogle(body?.results), source: 'google' };
    }

    if (!value) {
      const found = await this.nominatimReverse(lat, lng);
      if (found.address) value = { address: found.address, parts: found.parts, source: 'osm' };
    }
    if (!value) return { address: '', parts: {}, source: 'none' }; // not cached: retry next time
    this.remember(key, value);
    return value;
  }

  /**
   * The district and PIN a pin sits in, for checking it against what the host
   * typed. Null when no provider could say (the caller fails open).
   */
  async reverseCheck(lat: number, lng: number): Promise<{ district?: string; pincode?: string } | null> {
    try {
      const r = await this.reverse(lat, lng);
      if (r.source === 'none') return null;
      return { district: r.parts.district, pincode: r.parts.pincode };
    } catch (err) {
      this.logger.warn(`Reverse check failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async resolve(
    district: string,
    tehsil: string,
    query: string,
    centre: Point,
  ): Promise<GeocodeResult> {
    const place = `${tehsil}, ${district}, Himachal Pradesh, India`;
    const ctx = { googleDown: false };

    if (query) {
      const hit = await this.find(`${query}, ${place}`, centre, ctx);
      if (hit) {
        return hit.precision === 'area'
          ? { ...hit.point, precision: 'area', source: hit.source, message: "We found the area but not the exact spot. Move the pin onto the property." }
          : { ...hit.point, precision: 'exact', source: hit.source, message: 'Found it. Check the pin and move it if it is a little off.' };
      }
    }

    const tehsilHit = await this.find(place, centre, ctx);
    if (tehsilHit) {
      return {
        ...tehsilHit.point,
        precision: 'tehsil',
        source: tehsilHit.source,
        message: query
          ? `We could not find that exact place, so the pin is near ${tehsil}. Move it onto the property.`
          : `The pin is near ${tehsil}. Move it onto the property.`,
      };
    }

    return {
      ...centre,
      precision: 'district',
      source: 'fallback',
      message: `We could not look that place up, so the pin is at the centre of ${district}. Move it onto the property.`,
    };
  }

  /** One lookup step: Google first, then OpenStreetMap when Google has nothing usable. */
  private async find(text: string, centre: Point, ctx: { googleDown: boolean }): Promise<Candidate | null> {
    return (await this.googleSearch(text, centre, ctx)) ?? (await this.search(text, centre));
  }

  /** The first Google result that is inside Himachal Pradesh and near the chosen district. */
  private async googleSearch(text: string, centre: Point, ctx: { googleDown: boolean }): Promise<Candidate | null> {
    const body = await this.googleGet(
      new URLSearchParams({ address: text, components: 'country:IN|administrative_area:Himachal Pradesh' }),
      ctx,
    );
    for (const r of body?.results ?? []) {
      const point = { lat: Number(r.geometry?.location?.lat), lng: Number(r.geometry?.location?.lng) };
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue;
      if (!isInsideHimachal(point.lat, point.lng)) continue;
      if (distanceKm(point, centre) > MAX_KM_FROM_DISTRICT_CENTRE) continue;
      return {
        point: { lat: round(point.lat), lng: round(point.lng) },
        precision: googlePrecision(r.geometry?.location_type, r.types ?? []),
        source: 'google',
      };
    }
    return null;
  }

  /**
   * Calls Google's Geocoding API. Returns the body for OK and ZERO_RESULTS, and
   * null whenever Google is not usable (no key, paused, or any failure) — the
   * caller then falls back to OpenStreetMap. Nothing logged ever carries the key.
   */
  private async googleGet(params: URLSearchParams, ctx: { googleDown: boolean }): Promise<GoogleBody | null> {
    if (!this.googleKey || ctx.googleDown || Date.now() < this.googlePausedUntil) return null;
    params.set('key', this.googleKey);
    const fail = (why: string) => {
      ctx.googleDown = true; // do not ask again within this request
      this.logger.warn(`Google geocoding unavailable (${scrub(why)}); using OpenStreetMap`);
      return null;
    };
    try {
      const res = await fetch(`${this.googleBase}/maps/api/geocode/json?${params.toString()}`, {
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      });
      if (!res.ok) return fail(`HTTP ${res.status}`);
      const body = (await res.json()) as GoogleBody;
      const status = body?.status ?? '';
      if (status === 'OK' || status === 'ZERO_RESULTS') return body;
      if (GOOGLE_BREAKER_STATUSES.has(status)) {
        this.googlePausedUntil = Date.now() + GOOGLE_BREAKER_MS;
        return fail(`${status}${body.error_message ? `: ${body.error_message}` : ''}; pausing Google for 5 minutes`);
      }
      return fail(GOOGLE_ERROR_STATUSES.has(status) ? status : `unexpected status ${status || 'none'}`);
    } catch (err) {
      return fail((err as Error).message);
    }
  }

  /** The first OpenStreetMap hit that is inside Himachal Pradesh and near the chosen district. */
  private async search(text: string, centre: Point): Promise<Candidate | null> {
    const url = `${this.baseUrl}/search?format=jsonv2&limit=5&countrycodes=in&addressdetails=0&q=${encodeURIComponent(text)}`;
    const hits = await this.enqueue(async (): Promise<NominatimHit[]> => {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': OSM_USER_AGENT, 'Accept-Language': 'en' },
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        });
        if (!res.ok) {
          this.logger.warn(`Nominatim answered ${res.status} for a location lookup`);
          return [];
        }
        const body = await res.json();
        return Array.isArray(body) ? body : [];
      } catch (err) {
        this.logger.warn(`Nominatim lookup failed: ${(err as Error).message}`);
        return [];
      }
    });

    for (const h of hits) {
      const point = { lat: Number(h.lat), lng: Number(h.lon) };
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue;
      if (!isInsideHimachal(point.lat, point.lng)) continue;
      if (distanceKm(point, centre) > MAX_KM_FROM_DISTRICT_CENTRE) continue;
      const broad = BROAD_TYPES.has(h.addresstype ?? h.type ?? '') || h.category === 'boundary';
      return { point: { lat: round(point.lat), lng: round(point.lng) }, precision: broad ? 'area' : 'exact', source: 'osm' };
    }
    return null;
  }

  private async nominatimReverse(lat: number, lng: number): Promise<{ address: string; parts: AddressParts }> {
    const url = `${this.baseUrl}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
    return this.enqueue(async () => {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': OSM_USER_AGENT, 'Accept-Language': 'en' },
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        });
        if (!res.ok) {
          this.logger.warn(`Nominatim answered ${res.status} for a reverse lookup`);
          return { address: '', parts: {} };
        }
        const body = (await res.json()) as { display_name?: unknown; address?: Record<string, string> };
        const address = typeof body?.display_name === 'string' ? body.display_name.trim() : '';
        return { address, parts: address ? partsFromNominatim(body.address, address) : {} };
      } catch (err) {
        this.logger.warn(`Nominatim reverse lookup failed: ${(err as Error).message}`);
        return { address: '', parts: {} };
      }
    });
  }

  /** Runs outbound lookups one at a time, at least a second apart. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastLookupAt + this.minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastLookupAt = Date.now();
      return job();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private recall<T extends GeocodeResult | ReverseResult>(key: string): T | null {
    const cached = this.cache.get(key);
    return cached && Date.now() - cached.at < CACHE_TTL_MS ? (cached.value as T) : null;
  }

  private remember(key: string, value: GeocodeResult | ReverseResult) {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: Date.now(), value });
  }
}

const round = (n: number) => Number(n.toFixed(5));

/**
 * How close a Google result is to a specific spot. Rooftop and interpolated
 * street-number matches are exact; a geometric centre is only exact when the
 * result is a place-like thing (not a whole locality); approximate is an area.
 * A result that names only a region is an area whatever Google says about it.
 */
function googlePrecision(locationType: string | undefined, types: string[]): 'exact' | 'area' {
  const pointLike = types.some((t) => GOOGLE_POINT_TYPES.has(t));
  const onlyBroad = types.length > 0 && !pointLike && types.every((t) => GOOGLE_BROAD_TYPES.has(t));
  if (onlyBroad) return 'area';
  if (locationType === 'ROOFTOP' || locationType === 'RANGE_INTERPOLATED') return 'exact';
  if (locationType === 'GEOMETRIC_CENTER') return pointLike ? 'exact' : 'area';
  return 'area';
}
