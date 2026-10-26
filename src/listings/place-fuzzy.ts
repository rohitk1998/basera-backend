export function foldPlace(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function placeSkeleton(s: string): string {
  return foldPlace(s).replace(/ /g, '').replace(/(.)\1+/g, '$1');
}

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

export function fuzzyBudget(word: string): number {
  return word.length < 4 ? 0 : word.length <= 5 ? 1 : 2;
}

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

export function nearbyPlaceFor(q: string | null | undefined): { key: string; label: string; parent: string } | null {
  if (!q) return null;
  const key = foldPlace(q);
  return Object.prototype.hasOwnProperty.call(NEARBY_PLACES, key) ? { key, ...NEARBY_PLACES[key] } : null;
}

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

export function spellingVariantFor(q: string | null | undefined): string | null {
  if (!q) return null;
  const key = foldPlace(q);
  return Object.prototype.hasOwnProperty.call(SPELLING_VARIANTS, key) ? SPELLING_VARIANTS[key] : null;
}
