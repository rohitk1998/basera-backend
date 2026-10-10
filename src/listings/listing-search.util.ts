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

// Matches the SQL-level ::date casts: a string that looks like a date but is
// not one (2026-13-45) would otherwise be a Postgres error, not "no match".
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Everything the public search accepts, already validated — see normalizeListingSearch(). */
export type ListingSearchParams = {
  q?: string;
  district?: string;
  tehsil?: string;
  category?: CategoryId;
  minGuests?: number;
  moveIn?: string;
  moveOut?: string;
  sortByTrust?: boolean;
  locale?: string;
  page?: number;
  pageSize?: number;
  facets?: boolean;
};

/** A repeated query param (`?q=a&q=b`) arrives as an array — take the first value. */
export function firstValue(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

/** First value, as a trimmed string capped at `max` characters; undefined when blank or not a string. */
export function cleanText(v: unknown, max = MAX_QUERY_LENGTH): string | undefined {
  const value = firstValue(v);
  if (typeof value !== 'string') return undefined;
  // Control characters have no business in a place name and can upset the DB driver.
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max).trim();
  return text || undefined;
}

/** The canonical HP_DISTRICTS spelling for a case-insensitive match, or undefined for anything else. */
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

/** page >= 1, pageSize in [1, MAX_PAGE_SIZE] and never unbounded: default DEFAULT_PAGE_SIZE. */
export function clampPagination(page: unknown, pageSize: unknown): { page: number; pageSize: number } {
  const p = typeof page === 'number' ? page : (parseInteger(page) ?? 1);
  const s = typeof pageSize === 'number' ? pageSize : parseInteger(pageSize);
  return {
    page: Math.min(Math.max(Number.isFinite(p) ? Math.floor(p) : 1, 1), MAX_PAGE),
    pageSize: s && s > 0 ? Math.min(Math.floor(s), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE,
  };
}

/**
 * Turns the raw query string of GET /api/listings into validated search
 * params. Nothing here throws: an unknown district or category, a malformed
 * date or a non-numeric page is dropped (or defaulted), never a 400/500.
 * `town` and `location` are the old names for the free-text search `q`.
 */
export function normalizeListingSearch(raw: Record<string, unknown>): ListingSearchParams {
  const q = cleanText(raw.q) ?? cleanText(raw.town) ?? cleanText(raw.location);
  const guests = parseInteger(raw.guests);
  const facets = firstValue(raw.facets);
  const sort = firstValue(raw.sort);
  const locale = cleanText(raw.locale, 16);
  const { page, pageSize } = clampPagination(raw.page, raw.pageSize);

  return {
    q,
    district: canonicalDistrict(raw.district),
    tehsil: cleanText(raw.tehsil),
    category: parseCategory(raw.category),
    minGuests: guests && guests > 0 ? Math.min(guests, MAX_GUESTS) : undefined,
    moveIn: parseIsoDate(raw.date),
    moveOut: parseIsoDate(raw.dateEnd),
    sortByTrust: sort === 'trust',
    locale,
    page,
    pageSize,
    facets: facets === '1' || facets === 'true' || facets === 1 || facets === true,
  };
}

/** Escapes LIKE wildcards (and the escape character itself) in user input. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

/** Splits a free-text query into lower-case words (whitespace and commas), capped in count. */
export function queryWords(q: string): string[] {
  const text = cleanText(q);
  return text ? text.toLowerCase().split(/[\s,]+/).filter(Boolean).slice(0, MAX_TOKENS) : [];
}

/** The property_details fields the free-text search looks in (never description — it is noise). */
export const SEARCH_FIELDS = ['title', 'town', 'tehsil', 'district', 'city', 'locality', 'streetAddress'] as const;

export const PD = "l.draft_data->'property_details'";
export const pd = (field: string) => `${PD}->>'${field}'`;

export type SqlCondition = { sql: string; params: Record<string, unknown> };

/**
 * The WHERE fragment for a free-text query, or null when it has no usable words.
 *
 * Every word must match (AND). A word matches when any searched field has a
 * word that STARTS with it — `field ILIKE 'tok%' OR field ILIKE '% tok%'` — so
 * "bir" finds "Bir Billing" but not "Kabir". A word (or run of words) that is
 * a known tourist name also matches listings in the district/tehsil it stands
 * for, OR-ed with the plain text match: "kasol" finds a Bhuntar listing.
 */
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
