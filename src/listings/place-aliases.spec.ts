import { HP_DISTRICTS, isTehsilOf } from './hp-locations';
import { LEGACY_PLACE_NAMES } from './location.util';
import { PLACE_ALIASES, normalizePlaceName, placeAliasFor, splitQueryUnits } from './place-aliases';

describe('PLACE_ALIASES', () => {
  it('maps every alias to a real district and a tehsil that belongs to it', () => {
    for (const [name, alias] of Object.entries(PLACE_ALIASES)) {
      expect(HP_DISTRICTS).toContain(alias.district);
      expect({ name, ok: isTehsilOf(alias.district, alias.tehsil) }).toEqual({ name, ok: true });
    }
  });

  it('keys are normalised so lookups cannot silently miss', () => {
    for (const key of Object.keys(PLACE_ALIASES)) expect(key).toBe(normalizePlaceName(key));
  });

  it('covers every legacy town name and the curated tourist names', () => {
    for (const name of LEGACY_PLACE_NAMES) expect({ name, alias: placeAliasFor(name) }).not.toEqual({ name, alias: null });
    for (const name of ['McLeodganj', 'Kasol', 'Bir', 'Spiti Valley', 'Kufri', 'Manikaran', 'Tosh', 'Barot', 'Chitkul', 'Narkanda']) {
      expect({ name, alias: placeAliasFor(name) }).not.toEqual({ name, alias: null });
    }
  });

  it('resolves Kasol to Bhuntar tehsil in Kullu district, ignoring case and spacing', () => {
    expect(placeAliasFor('Kasol')).toEqual({ district: 'Kullu', tehsil: 'Bhuntar' });
    expect(placeAliasFor('  SPITI   valley ')).toEqual({ district: 'Lahaul and Spiti', tehsil: 'Kaza' });
  });

  it('does not treat inherited object keys or unknown names as aliases', () => {
    expect(placeAliasFor('constructor')).toBeNull();
    expect(placeAliasFor('__proto__')).toBeNull();
    expect(placeAliasFor('Atlantis')).toBeNull();
    expect(placeAliasFor('')).toBeNull();
    expect(placeAliasFor(undefined)).toBeNull();
  });
});

describe('splitQueryUnits', () => {
  it('keeps a multi-word alias together and leaves other words alone', () => {
    const units = splitQueryUnits(['spiti', 'valley', 'cottage']);
    expect(units.map((u) => u.words.join(' '))).toEqual(['spiti valley', 'cottage']);
    expect(units[0].alias).toEqual({ district: 'Lahaul and Spiti', tehsil: 'Kaza' });
    expect(units[1].alias).toBeNull();
  });

  it('flags a single-word alias', () => {
    expect(splitQueryUnits(['kasol'])).toEqual([{ words: ['kasol'], alias: { district: 'Kullu', tehsil: 'Bhuntar' } }]);
  });

  it('an alias word on its own (spiti) is plain text, not an alias', () => {
    expect(splitQueryUnits(['spiti'])).toEqual([{ words: ['spiti'], alias: null }]);
  });
});
