import type { CategoryId } from './listing.types';
import { HP_DISTRICTS } from './hp-locations';
import { splitQueryUnits } from './place-aliases';

export const CATEGORY_IDS: readonly CategoryId[] = ['long', 'entire', 'work', 'views', 'quiet'];

export const DEFAULT_PAGE_SIZE = 48;
export const MAX_PAGE_SIZE = 200;
const MAX_PAGE = 100_000;
const MAX_QUERY_LENGTH = 80;
const MAX_TOKENS = 8;
const MAX_GUESTS = 100;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const LISTING_SORTS = ['newest', 'price_asc', 'price_desc', 'trust'] as const;
export type ListingSort = (typeof LISTING_SORTS)[number];
export const MAX_FILTER_PRICE = 1_000_000;
const MAX_BEDROOMS = 10;

export type ListingSearchParams = {
  q?: string;
  district?: string;
  tehsil?: string;
  category?: CategoryId;
  minGuests?: number;

  pets?: number;
  moveIn?: string;
  moveOut?: string;
  sortByTrust?: boolean;
  sort?: ListingSort;
  minPrice?: number;
  maxPrice?: number;
  propertyType?: string;
  /** Minimum bedrooms (0 = studio and up). */
  bedrooms?: number;
  locale?: string;
  page?: number;
  pageSize?: number;
  facets?: boolean;

  exact?: boolean;

  /** Opt in to Google-discovered stays on the grid. */
  includeDiscovered?: boolean;
  /** Hydrate discovered cards from Google (controller only; never part of cache keys). Defaults to true. */
  hydrate?: boolean;
};

export function firstValue(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

export function cleanText(v: unknown, max = MAX_QUERY_LENGTH): string | undefined {
  const value = firstValue(v);
  if (typeof value !== 'string') return undefined;

  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max).trim();
  return text || undefined;
}

export function canonicalDistrict(v: unknown): string | undefined {
  const text = cleanText(v);
  if (!text) return undefined;
  const wanted = text.toLowerCase().replace(/\s+/g, ' ');
  return HP_DISTRICTS.find((d) => d.toLowerCase() === wanted);
}

export function parseCategory(v: unknown): CategoryId | undefined {
  const text = cleanText(v);
  return text && (CATEGORY_IDS as readonly string[]).includes(text) ? (text as CategoryId) : undefined;
}

function parseInteger(v: unknown): number | undefined {
  const value = firstValue(v);
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function parseIsoDate(v: unknown): string | undefined {
  const text = cleanText(v, 10);
  if (!text || !ISO_DATE.test(text)) return undefined;
  const d = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text ? undefined : text;
}

export function clampPagination(page: unknown, pageSize: unknown): { page: number; pageSize: number } {
  const p = typeof page === 'number' ? page : (parseInteger(page) ?? 1);
  const s = typeof pageSize === 'number' ? pageSize : parseInteger(pageSize);
  return {
    page: Math.min(Math.max(Number.isFinite(p) ? Math.floor(p) : 1, 1), MAX_PAGE),
    pageSize: s && s > 0 ? Math.min(Math.floor(s), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE,
  };
}

export function parseSort(v: unknown): ListingSort | undefined {
  const text = cleanText(firstValue(v), 16);
  return text && (LISTING_SORTS as readonly string[]).includes(text) ? (text as ListingSort) : undefined;
}

export function parsePropertyType(v: unknown): string | undefined {
  const text = cleanText(v, 32);
  return text && /^[A-Za-z]+$/.test(text) ? text : undefined;
}

/** Price range in integer rupees; a reversed range is swapped rather than returning nothing. */
export function parsePriceRange(min: unknown, max: unknown): { minPrice?: number; maxPrice?: number } {
  const clamp = (n: number | undefined) => (n === undefined ? undefined : Math.min(n, MAX_FILTER_PRICE));
  let lo = clamp(parseInteger(min));
  let hi = clamp(parseInteger(max));
  if (lo !== undefined && hi !== undefined && lo > hi) [lo, hi] = [hi, lo];
  return { minPrice: lo && lo > 0 ? lo : undefined, maxPrice: hi && hi > 0 ? hi : undefined };
}

function parseFlag(v: unknown): boolean {
  const value = firstValue(v);
  return value === '1' || value === 'true' || value === 1 || value === true;
}

export function normalizeListingSearch(raw: Record<string, unknown>): ListingSearchParams {
  const q = cleanText(raw.q) ?? cleanText(raw.town) ?? cleanText(raw.location);
  const guests = parseInteger(raw.guests);
  const pets = parseInteger(raw.pets);
  const facets = firstValue(raw.facets);
  const sort = firstValue(raw.sort);
  const locale = cleanText(raw.locale, 16);
  const { page, pageSize } = clampPagination(raw.page, raw.pageSize);
  const bedrooms = parseInteger(raw.bedrooms);

  return {
    ...parsePriceRange(raw.minPrice, raw.maxPrice),
    propertyType: parsePropertyType(raw.propertyType),
    bedrooms: bedrooms !== undefined && bedrooms > 0 ? Math.min(bedrooms, MAX_BEDROOMS) : undefined,
    sort: parseSort(sort),
    q,
    district: canonicalDistrict(raw.district),
    tehsil: cleanText(raw.tehsil),
    category: parseCategory(raw.category),
    minGuests: guests && guests > 0 ? Math.min(guests, MAX_GUESTS) : undefined,
    pets: pets && pets > 0 ? Math.min(pets, MAX_GUESTS) : undefined,
    moveIn: parseIsoDate(raw.date),
    moveOut: parseIsoDate(raw.dateEnd),
    sortByTrust: sort === 'trust',
    locale,
    page,
    pageSize,
    exact: firstValue(raw.exact) === '1' ? true : undefined,
    facets: facets === '1' || facets === 'true' || facets === 1 || facets === true,
    includeDiscovered: parseFlag(raw.discovered),
    hydrate: !['0', 'false'].includes(String(firstValue(raw.hydrate))),
  };
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

export function queryWords(q: string): string[] {
  const text = cleanText(q);
  return text ? text.toLowerCase().split(/[\s,]+/).filter(Boolean).slice(0, MAX_TOKENS) : [];
}

export const SEARCH_FIELDS = ['title', 'town', 'tehsil', 'district', 'city', 'locality', 'streetAddress'] as const;

export const PD = "l.draft_data->'property_details'";
export const pd = (field: string) => `${PD}->>'${field}'`;

export type SqlCondition = { sql: string; params: Record<string, unknown> };

export function buildTextCondition(q: string | undefined, prefix = 'q'): SqlCondition | null {
  const words = q ? queryWords(q) : [];
  if (words.length === 0) return null;

  const params: Record<string, unknown> = {};
  let n = 0;

  const wordSql = (word: string): string => {
    const start = `${prefix}s${n}`;
    const inside = `${prefix}w${n}`;
    n++;
    params[start] = `${escapeLike(word)}%`;
    params[inside] = `% ${escapeLike(word)}%`;
    return `(${SEARCH_FIELDS.map((f) => `${pd(f)} ILIKE :${start} OR ${pd(f)} ILIKE :${inside}`).join(' OR ')})`;
  };

  const unitSql = splitQueryUnits(words).map((unit) => {
    const text = unit.words.map(wordSql).join(' AND ');
    if (!unit.alias) return `(${text})`;
    const d = `${prefix}ad${n}`;
    const t = `${prefix}at${n}`;
    n++;
    params[d] = unit.alias.district.toLowerCase();
    params[t] = unit.alias.tehsil.toLowerCase();
    return `((${text}) OR (lower(${pd('district')}) = :${d} AND lower(${pd('tehsil')}) = :${t}))`;
  });

  return { sql: `(${unitSql.join(' AND ')})`, params };
}

/**
 * Text condition for discovered rows. Only our own derived location columns and the discovery
 * destination are searched: never title, name or address. Param names carry a d_ prefix.
 */
export function buildDiscoveredTextCondition(q: string | undefined, prefix = 'd_q'): SqlCondition | null {
  const words = q ? queryWords(q) : [];
  if (words.length === 0) return null;

  const params: Record<string, unknown> = {};
  let n = 0;

  const wordSql = (word: string): string => {
    const start = `${prefix}s${n}`;
    const inside = `${prefix}w${n}`;
    n++;
    params[start] = `${escapeLike(word)}%`;
    params[inside] = `% ${escapeLike(word)}%`;
    return `(l.disc_district ILIKE :${start} OR l.disc_tehsil ILIKE :${start} OR l.disc_tehsil ILIKE :${inside} OR l.discovery_destination ILIKE :${start})`;
  };

  const unitSql = splitQueryUnits(words).map((unit) => {
    const text = unit.words.map(wordSql).join(' AND ');
    if (!unit.alias) return `(${text})`;
    const d = `${prefix}ad${n}`;
    const t = `${prefix}at${n}`;
    n++;
    params[d] = unit.alias.district.toLowerCase();
    params[t] = unit.alias.tehsil.toLowerCase();
    return `((${text}) OR (lower(l.disc_district) = :${d} AND lower(l.disc_tehsil) = :${t}))`;
  });

  return { sql: `(${unitSql.join(' AND ')})`, params };
}
