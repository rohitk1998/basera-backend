import { HP_DISTRICTS, HP_LOCATIONS } from './hp-locations';
import { PLACE_ALIASES, placeAliasFor } from './place-aliases';
import { NEARBY_PLACES, SPELLING_VARIANTS, spellingVariantFor, buildPlaceVocab, correctPlaceQuery, damerauLevenshtein, foldPlace, nearbyPlaceFor } from './place-fuzzy';
import { buildTextCondition } from './listing-search.util';

const vocab = buildPlaceVocab([
  ...HP_DISTRICTS,
  ...Object.keys(PLACE_ALIASES),
  ...HP_DISTRICTS.flatMap((d) => HP_LOCATIONS[d].tehsils),
]);
const fix = (q: string) => correctPlaceQuery(q, vocab)?.query ?? null;

describe('place-fuzzy', () => {
  it('folds case, diacritics and punctuation', () => {
    expect(foldPlace('  McLeod-Ganj, Ká ')).toBe('mcleod ganj ka');
  });

  it('measures insertions, swaps and substitutions as one edit', () => {
    expect(damerauLevenshtein('dharmshala', 'dharamshala')).toBe(1);
    expect(damerauLevenshtein('shimal', 'shimla')).toBe(1);
    expect(damerauLevenshtein('kasol', 'kasal')).toBe(1);
  });

  it('corrects common misspellings over the real vocabulary', () => {
    const dharamshala = placeAliasFor('dharamshala');
    expect(placeAliasFor(fix('dharmshla'))).toEqual(dharamshala);
    expect(placeAliasFor(fix('dharmashala'))).toEqual(dharamshala);
    expect(fix('manalee')?.toLowerCase()).toBe('manali');
    expect(fix('kinaur')?.toLowerCase()).toBe('kinnaur');
    expect(fix('chambaa')?.toLowerCase()).toBe('chamba');
  });

  it('leaves exact names, prefixes, short words and gibberish alone', () => {
    expect(fix('Manali')).toBeNull();
    expect(fix('dhara')).toBeNull();
    expect(fix('bar')).toBeNull();
    expect(fix('zzzzqq')).toBeNull();
  });

  it('every nearby village has an alias into a real tehsil, and the Dharamshala ones share its tehsil', () => {
    for (const [key, { parent }] of Object.entries(NEARBY_PLACES)) {
      const alias = placeAliasFor(key);
      expect({ key, alias: alias !== null }).toEqual({ key, alias: true });
      if (parent === 'Dharamshala') expect(alias).toEqual(placeAliasFor(parent));
    }
    expect(nearbyPlaceFor('Bhagsu')?.parent).toBe('Dharamshala');
  });

  it('every spelling variant is a real alias whose usual spelling resolves to the same area', () => {
    for (const key of Object.keys(SPELLING_VARIANTS)) {
      expect({ key, alias: placeAliasFor(key) !== null }).toEqual({ key, alias: true });
      expect(placeAliasFor(SPELLING_VARIANTS[key])).toEqual(placeAliasFor(key));
    }
    expect(spellingVariantFor('Dharmshala')).toBe('Dharamshala');
    expect(spellingVariantFor('Dharamshala')).toBeNull();
  });

  it('resolves the QA spellings to the Dharamshala tehsil in Kangra through the SQL text condition', () => {
    for (const q of ['dharmshala', 'dharamsala', 'bhagsu', 'dharamkot', 'simla']) {
      const cond = buildTextCondition(q);
      expect(cond).not.toBeNull();
      expect(Object.values(cond!.params)).toContain(q === 'simla' ? 'shimla urban' : 'dharamshala');
    }
  });
});
