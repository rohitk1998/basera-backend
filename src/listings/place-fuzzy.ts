/**
 * Misspelling tolerance for place search ("dharmshala", "simla", "bhagsu").
 *
 * Pure, dependency-free helpers: a normaliser, a Damerau-Levenshtein distance,
 * a token-wise corrector over a vocabulary, and the curated "nearby village ->
 * parent town" labels. Exact spelling variants that map to a real tehsil live
 * in PLACE_ALIASES (place-aliases.ts); this file is the fallback for everything
 * those do not list.
 *
 * Plain data/logic module (no 'use client', no imports) so the backend
 * (src/listings/place-fuzzy.ts) and the web app (lib/place-fuzzy.ts) keep
 * byte-identical copies, and scripts/check-place-fuzzy.mjs can load it alone.
 */

/** Lower-case, diacritics and punctuation stripped, single-spaced. "McLeod-Ganj" -> "mcleod ganj". */
export function foldPlace(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** foldPlace without spaces and with doubled letters collapsed: "Manaali" and "Mcleod Ganj" -> "manali", "mcleodganj". */
export function placeSkeleton(s: string): string {
  return foldPlace(s).replace(/ /g, '').replace(/(.)\1+/g, '$1');
}

/** Optimal-string-alignment (Damerau-Levenshtein) distance: insert, delete, substitute, swap neighbours. */
export function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push(new Array<number>(b.length + 1).fill(0));
    rows[i][0] = i;
  }
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2][j - 2] + cost);
      rows[i][j] = d;
    }
  }
  return rows[a.length][b.length];
}

/** Edits tolerated for a word: none under 4 letters (too ambiguous), 1 up to 5, 2 beyond. */
export function fuzzyBudget(word: string): number {
  return word.length < 4 ? 0 : word.length <= 5 ? 1 : 2;
}

/** A vocabulary prepared once: each distinct term with its skeleton and words. */
export type PlaceVocab = { terms: { name: string; skeleton: string; words: string[] }[]; words: Set<string> };

export function buildPlaceVocab(names: Iterable<string>): PlaceVocab {
  const seen = new Set<string>();
  const terms: PlaceVocab['terms'] = [];
  const words = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    const folded = foldPlace(name);
    if (!folded || seen.has(folded)) continue;
    seen.add(folded);
    const w = folded.split(' ');
    terms.push({ name, skeleton: placeSkeleton(name), words: w });
    for (const x of w) words.add(x);
  }
  return { terms, words };
}

/** The closest vocabulary term to `text` within the edit budget (prefix of a term counts as exact), or null. */
export function closestTerm(text: string, vocab: PlaceVocab): { name: string; distance: number } | null {
  const skeleton = placeSkeleton(text);
  if (skeleton.length < 3) return null;
  let best: { name: string; distance: number } | null = null;
  const budget = fuzzyBudget(skeleton);
  for (const term of vocab.terms) {
    let distance = Infinity;
    if (term.skeleton === skeleton) distance = 0;
    else if (skeleton.length >= 4 && term.skeleton.startsWith(skeleton)) distance = 0.5;
    else if (budget > 0) {
      const d = damerauLevenshtein(skeleton, term.skeleton);
      if (d <= budget) distance = d;
      // A typo inside the first word of a longer name ("dharmshala" for "Dharamshala Cantt").
      if (term.words.length > 1 && distance === Infinity) {
        const first = placeSkeleton(term.words[0]);
        const d0 = damerauLevenshtein(skeleton, first);
        if (d0 <= budget) distance = d0 + 0.75;
      }
    }
    if (distance !== Infinity && (!best || distance < best.distance)) best = { name: term.name, distance };
  }
  return best;
}

export type PlaceCorrection = { query: string; corrected: boolean };

/**
 * Token-wise correction of a free-text query. A word that already is (or starts)
 * a vocabulary word is kept as typed; otherwise it is replaced by the closest
 * vocabulary term within budget. Adjacent words are tried together first, so
 * "mcleod gunj" can become "McLeodganj". Returns null when nothing changed.
 */
export function correctPlaceQuery(q: string, vocab: PlaceVocab): PlaceCorrection | null {
  const words = foldPlace(q).split(' ').filter(Boolean);
  if (words.length === 0) return null;
  const out: string[] = [];
  let changed = false;
  let i = 0;
  while (i < words.length) {
    let done = false;
    for (let len = Math.min(3, words.length - i); len >= 1 && !done; len--) {
      const chunk = words.slice(i, i + len).join(' ');
      const known = len === 1 && [...vocab.words].some((w) => w === chunk || (chunk.length >= 3 && w.startsWith(chunk)));
      if (known) {
        out.push(chunk);
        i += len;
        done = true;
        break;
      }
      const hit = closestTerm(chunk, vocab);
      if (hit && hit.distance < 3) {
        out.push(hit.name);
        changed = changed || foldPlace(hit.name) !== chunk;
        i += len;
        done = true;
      }
    }
    if (!done) {
      out.push(words[i]);
      i += 1;
    }
  }
  return changed ? { query: out.join(' '), corrected: true } : null;
}

/**
 * Small villages and trailheads folded into the town a guest should be shown
 * homes in. Key: folded name. Value: how the parent is labelled. The parent's
 * district/tehsil come from the same key in PLACE_ALIASES, so this table is
 * only the "Showing homes near X" label source. Only places we are sure of.
 */
export const NEARBY_PLACES: Readonly<Record<string, { label: string; parent: string }>> = {
  bhagsu: { label: 'Bhagsu', parent: 'Dharamshala' },
  dharamkot: { label: 'Dharamkot', parent: 'Dharamshala' },
  naddi: { label: 'Naddi', parent: 'Dharamshala' },
  'kotwali bazaar': { label: 'Kotwali Bazaar', parent: 'Dharamshala' },
  gunehar: { label: 'Gunehar', parent: 'Dharamshala' },
  triund: { label: 'Triund', parent: 'Dharamshala' },
  naggar: { label: 'Naggar', parent: 'Kullu' },
  tosh: { label: 'Tosh', parent: 'Kullu' },
};

/** The nearby-village entry for a whole query ("Bhagsu", "bhagsunag"), or null. */
export function nearbyPlaceFor(q: string | null | undefined): { key: string; label: string; parent: string } | null {
  if (!q) return null;
  const key = foldPlace(q);
  return Object.prototype.hasOwnProperty.call(NEARBY_PLACES, key) ? { key, ...NEARBY_PLACES[key] } : null;
}

/**
 * Spellings guests commonly use for a place we know under another name. They
 * resolve through PLACE_ALIASES with no correction pass; this table only
 * supplies the name to show in "Showing results for X". Key: folded spelling.
 */
export const SPELLING_VARIANTS: Readonly<Record<string, string>> = {
  dharmshala: 'Dharamshala',
  dharmsala: 'Dharamshala',
  dharamsala: 'Dharamshala',
  mcleodgunj: 'McLeodganj',
  'mcleod gunj': 'McLeodganj',
  'mcleod ganj': 'McLeodganj',
  simla: 'Shimla',
  kulu: 'Kullu',
  manaali: 'Manali',
  kasoli: 'Kasauli',
  bhagsunag: 'Bhagsu',
  'bhagsu nag': 'Bhagsu',
};

/** The usual spelling of a whole query that is a known variant ("dharmshala" -> "Dharamshala"), or null. */
export function spellingVariantFor(q: string | null | undefined): string | null {
  if (!q) return null;
  const key = foldPlace(q);
  return Object.prototype.hasOwnProperty.call(SPELLING_VARIANTS, key) ? SPELLING_VARIANTS[key] : null;
}
