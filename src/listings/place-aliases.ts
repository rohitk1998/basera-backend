/**
 * Tourist place names guests actually type ("Kasol", "McLeodganj", "Spiti
 * Valley") mapped to the administrative {district, tehsil} a host would have
 * picked for a stay there. Most of these are villages or hill stations, not
 * tehsils, so a plain text match on the listing's tehsil/district would miss
 * them: someone searching "Kasol" has to find a listing whose tehsil is
 * Bhuntar, in Kullu district.
 *
 * The first block is the same legacy list the backend uses to upgrade old
 * `town`-only listings (LEGACY_PLACES in location.util.ts); the rest are the
 * curated tourist names that list was missing aliases for. Every tehsil must
 * exist in hp-locations.ts (place-aliases.spec.ts checks it).
 *
 * Plain data module (no 'use client'): the backend (src/listings/place-aliases.ts)
 * and the web app (lib/place-aliases.ts) keep byte-identical copies, like
 * hp-locations.ts. Keep the only import relative to the same folder so both
 * locations resolve it.
 */
import type { HpDistrict } from './hp-locations';

export type PlaceAlias = { district: HpDistrict; tehsil: string };

/** Keys are lower-case, single-spaced: look names up with `placeAliasFor`. */
export const PLACE_ALIASES: Readonly<Record<string, PlaceAlias>> = {
  // --- the legacy `town` list (LEGACY_PLACES) ---
  manali: { district: 'Kullu', tehsil: 'Manali' },
  shimla: { district: 'Shimla', tehsil: 'Shimla Urban' },
  dharamshala: { district: 'Kangra', tehsil: 'Dharamshala' },
  dalhousie: { district: 'Chamba', tehsil: 'Dalhousie' },
  kullu: { district: 'Kullu', tehsil: 'Kullu' },
  palampur: { district: 'Kangra', tehsil: 'Palampur' },
  chamba: { district: 'Chamba', tehsil: 'Chamba' },
  sarahan: { district: 'Shimla', tehsil: 'Rampur' },

  // --- curated tourist names that are not tehsils themselves ---
  mcleodganj: { district: 'Kangra', tehsil: 'Dharamshala' },
  kasol: { district: 'Kullu', tehsil: 'Bhuntar' },
  bir: { district: 'Kangra', tehsil: 'Baijnath' },
  'spiti valley': { district: 'Lahaul and Spiti', tehsil: 'Kaza' },
  kufri: { district: 'Shimla', tehsil: 'Shimla Rural' },
  manikaran: { district: 'Kullu', tehsil: 'Bhuntar' },
  tosh: { district: 'Kullu', tehsil: 'Bhuntar' },
  barot: { district: 'Mandi', tehsil: 'Joginder Nagar' },
  chitkul: { district: 'Kinnaur', tehsil: 'Sangla' },
  narkanda: { district: 'Shimla', tehsil: 'Kumarsain' },

  // --- common alternative spellings ---
  'mcleod ganj': { district: 'Kangra', tehsil: 'Dharamshala' },
  dharamsala: { district: 'Kangra', tehsil: 'Dharamshala' },
};

/** Lower-case, trim and collapse whitespace so "  Spiti   VALLEY " finds its alias. */
export function normalizePlaceName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The {district, tehsil} a tourist name stands for, or null when it is not a known alias. */
export function placeAliasFor(name: string | null | undefined): PlaceAlias | null {
  if (!name) return null;
  const key = normalizePlaceName(name);
  return Object.prototype.hasOwnProperty.call(PLACE_ALIASES, key) ? PLACE_ALIASES[key] : null;
}

/** One searchable unit of a query: one word, or a run of words that is a known alias ("spiti valley"). */
export type QueryUnit = { words: string[]; alias: PlaceAlias | null };

const MAX_ALIAS_WORDS = Math.max(...Object.keys(PLACE_ALIASES).map((k) => k.split(' ').length));

/**
 * Groups the (lower-case) words of a query into units, taking the longest
 * known alias at each position, so "spiti valley cottage" becomes
 * [spiti valley][cottage] and "kasol" becomes [kasol -> Bhuntar/Kullu].
 */
export function splitQueryUnits(words: readonly string[]): QueryUnit[] {
  const units: QueryUnit[] = [];
  let i = 0;
  while (i < words.length) {
    let matched = false;
    for (let len = Math.min(MAX_ALIAS_WORDS, words.length - i); len >= 1; len--) {
      const slice = words.slice(i, i + len);
      const alias = placeAliasFor(slice.join(' '));
      if (alias) {
        units.push({ words: slice, alias });
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      units.push({ words: [words[i]], alias: null });
      i += 1;
    }
  }
  return units;
}
