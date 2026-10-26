import { z } from 'zod';
import { type AttractionEntity } from '../entities/attraction.entity';
import {
  ATTRACTION_CATEGORIES,
  ATTRACTION_DIFFICULTIES,
  ATTRACTION_STATUSES,
  type AttractionCategory,
} from './attraction.types';
import {
  HP_DISTRICTS,
  HP_LOCATIONS,
  type HpDistrict,
} from '../listings/hp-locations';
import { placeAliasFor } from '../listings/place-aliases';

export const DISTRICT_SEARCH_RADIUS_M: Record<HpDistrict, number> = {
  Bilaspur: 30_000,
  Chamba: 55_000,
  Hamirpur: 25_000,
  Kangra: 45_000,
  Kinnaur: 60_000,
  Kullu: 45_000,
  'Lahaul and Spiti': 90_000,
  Mandi: 45_000,
  Shimla: 45_000,
  Sirmaur: 40_000,
  Solan: 30_000,
  Una: 30_000,
};

const DISTRICT_BY_LOWER = new Map(
  HP_DISTRICTS.map((d) => [d.toLowerCase(), d]),
);

function clean(v: unknown): string {
  const first: unknown = Array.isArray(v) ? (v as unknown[])[0] : v;
  return typeof first === 'string'
    ? first.replace(/\s+/g, ' ').trim().slice(0, 80)
    : '';
}

function districtOfTehsil(name: string): HpDistrict | null {
  const wanted = name.toLowerCase();
  for (const d of HP_DISTRICTS) {
    if (HP_LOCATIONS[d].tehsils.some((t) => t.toLowerCase() === wanted))
      return d;
  }
  return null;
}

export function resolveDistrict(
  query: Record<string, unknown>,
): HpDistrict | null {
  const district = DISTRICT_BY_LOWER.get(clean(query.district).toLowerCase());
  if (district) return district;

  const tehsil = clean(query.tehsil);
  if (tehsil) {
    const d = districtOfTehsil(tehsil);
    if (d) return d;
  }

  const q = clean(query.q);
  if (!q) return null;
  return (
    DISTRICT_BY_LOWER.get(q.toLowerCase()) ??
    placeAliasFor(q)?.district ??
    districtOfTehsil(q) ??
    null
  );
}

export function nearestDistrict(lat: number, lng: number): HpDistrict {
  let best: HpDistrict = HP_DISTRICTS[0];
  let bestD = Infinity;
  for (const d of HP_DISTRICTS) {
    const c = HP_LOCATIONS[d].centre;
    const dx = (lng - c.lng) * Math.cos((lat * Math.PI) / 180);
    const dy = lat - c.lat;
    const dist = dx * dx + dy * dy;
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

export function slugify(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 70) || 'place'
  );
}

export function uniqueSlug(
  name: string,
  district: string,
  taken: Set<string>,
): string {
  const base = slugify(name);
  const candidates = [base, `${base}-${slugify(district)}`];
  for (const c of candidates) if (!taken.has(c)) return c;
  for (let i = 2; ; i++) {
    const c = `${base}-${i}`;
    if (!taken.has(c)) return c;
  }
}

export function summarise(
  text: string | null | undefined,
  max = 160,
): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = cut.lastIndexOf('. ');
  return stop > 60
    ? cut.slice(0, stop + 1)
    : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

export function youtubeIdFrom(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(
    /(?:youtu\.be\/|v=|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/,
  );
  return m ? m[1] : null;
}

export type PublicAttraction = {
  id: string;
  slug: string;
  name: string;
  category: AttractionCategory;
  district: string;
  tehsil: string | null;
  lat: number;
  lng: number;
  summary: string | null;
  description: string | null;
  imageUrl: string | null;
  imageCredit: string | null;
  difficulty: string | null;
  duration: string | null;
  distanceKm: number | null;
  bestSeason: string | null;
  youtubeIds: string[];
  wikipediaUrl: string | null;
};

export function toPublicAttraction(a: AttractionEntity): PublicAttraction {
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    category: a.category,
    district: a.district,
    tehsil: a.tehsil,
    lat: a.lat,
    lng: a.lng,
    summary: a.summary ?? summarise(a.description),
    description: a.description,
    imageUrl: a.image_url,
    imageCredit: a.image_credit,
    difficulty: a.difficulty,
    duration: a.duration,
    distanceKm: a.distance_km,
    bestSeason: a.best_season,
    youtubeIds: a.youtube_ids ?? [],
    wikipediaUrl: a.wikipedia_url,
  };
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const attractionInputSchema = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(120),
  category: z.enum(ATTRACTION_CATEGORIES, { message: 'Pick a category' }),
  district: z.enum(HP_DISTRICTS, { message: 'Pick a Himachal district' }),
  tehsil: optionalText(80),
  lat: z.coerce.number().min(30).max(34, 'Latitude must be inside Himachal'),
  lng: z.coerce.number().min(75).max(80, 'Longitude must be inside Himachal'),
  summary: optionalText(200),
  description: optionalText(4000),
  difficulty: z.enum(ATTRACTION_DIFFICULTIES).nullable().optional(),
  duration: optionalText(60),
  distanceKm: z.coerce.number().min(0).max(9999).nullable().optional(),
  bestSeason: optionalText(60),
  youtubeIds: z
    .array(z.string())
    .max(6, 'Attach at most 6 videos')
    .transform((list, ctx) => {
      const ids: string[] = [];
      for (const raw of list) {
        const id = youtubeIdFrom(raw);
        if (!id) {
          ctx.addIssue({
            code: 'custom',
            message: `Not a YouTube video: ${raw}`,
          });
          return z.NEVER;
        }
        if (!ids.includes(id)) ids.push(id);
      }
      return ids;
    })
    .optional(),
  popularity: z.coerce.number().int().min(0).max(100).optional(),
  status: z.enum(ATTRACTION_STATUSES).optional(),
  commonsImage: optionalText(500),
});
export type AttractionInput = z.infer<typeof attractionInputSchema>;
export const attractionUpdateSchema = attractionInputSchema.partial();
export type AttractionUpdate = z.infer<typeof attractionUpdateSchema>;
