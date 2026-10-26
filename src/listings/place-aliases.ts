import type { HpDistrict } from './hp-locations';

export type PlaceAlias = { district: HpDistrict; tehsil: string };

export const PLACE_ALIASES: Readonly<Record<string, PlaceAlias>> = {

  manali: { district: 'Kullu', tehsil: 'Manali' },
  shimla: { district: 'Shimla', tehsil: 'Shimla Urban' },
  dharamshala: { district: 'Kangra', tehsil: 'Dharamshala' },
  dalhousie: { district: 'Chamba', tehsil: 'Dalhousie' },
  kullu: { district: 'Kullu', tehsil: 'Kullu' },
  palampur: { district: 'Kangra', tehsil: 'Palampur' },
  chamba: { district: 'Chamba', tehsil: 'Chamba' },
  sarahan: { district: 'Shimla', tehsil: 'Rampur' },

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

  'mcleod ganj': { district: 'Kangra', tehsil: 'Dharamshala' },
  dharamsala: { district: 'Kangra', tehsil: 'Dharamshala' },
  dharmshala: { district: 'Kangra', tehsil: 'Dharamshala' },
  dharmsala: { district: 'Kangra', tehsil: 'Dharamshala' },
  mcleodgunj: { district: 'Kangra', tehsil: 'Dharamshala' },
  'mcleod gunj': { district: 'Kangra', tehsil: 'Dharamshala' },
  mcleod: { district: 'Kangra', tehsil: 'Dharamshala' },
  simla: { district: 'Shimla', tehsil: 'Shimla Urban' },
  kulu: { district: 'Kullu', tehsil: 'Kullu' },
  manaali: { district: 'Kullu', tehsil: 'Manali' },
  kasauli: { district: 'Solan', tehsil: 'Kasauli' },
  kasoli: { district: 'Solan', tehsil: 'Kasauli' },

  bhagsu: { district: 'Kangra', tehsil: 'Dharamshala' },
  bhagsunag: { district: 'Kangra', tehsil: 'Dharamshala' },
  'bhagsu nag': { district: 'Kangra', tehsil: 'Dharamshala' },
  dharamkot: { district: 'Kangra', tehsil: 'Dharamshala' },
  naddi: { district: 'Kangra', tehsil: 'Dharamshala' },
  'kotwali bazaar': { district: 'Kangra', tehsil: 'Dharamshala' },
  gunehar: { district: 'Kangra', tehsil: 'Dharamshala' },
  triund: { district: 'Kangra', tehsil: 'Dharamshala' },
  naggar: { district: 'Kullu', tehsil: 'Kullu' },
};

export function normalizePlaceName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function placeAliasFor(name: string | null | undefined): PlaceAlias | null {
  if (!name) return null;
  const key = normalizePlaceName(name);
  return Object.prototype.hasOwnProperty.call(PLACE_ALIASES, key) ? PLACE_ALIASES[key] : null;
}

export type QueryUnit = { words: string[]; alias: PlaceAlias | null };

const MAX_ALIAS_WORDS = Math.max(...Object.keys(PLACE_ALIASES).map((k) => k.split(' ').length));

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
