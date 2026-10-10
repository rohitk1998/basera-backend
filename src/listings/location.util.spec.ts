import { BadRequestException } from '@nestjs/common';
import { locationSchema } from './listing-schema';
import { isTehsilOf } from './hp-locations';
import { LEGACY_PLACE_NAMES, assertLocationIsValid, upgradeLegacyLocation } from './location.util';

describe('upgradeLegacyLocation', () => {
  it.each(LEGACY_PLACE_NAMES)('gives the old town "%s" a district and a tehsil that really belong together', (town) => {
    const up = upgradeLegacyLocation({ town }) as any;
    expect(up.town).toBe(town);
    expect(isTehsilOf(up.district, up.tehsil)).toBe(true);
  });

  it('never overrides a district or tehsil the client sent', () => {
    const up = upgradeLegacyLocation({ town: 'Manali', district: 'Mandi', tehsil: 'Karsog' }) as any;
    expect(up).toMatchObject({ district: 'Mandi', tehsil: 'Karsog', town: 'Manali' });
  });

  it('fills town from the tehsil when a new client sends none', () => {
    expect(upgradeLegacyLocation({ district: 'Kangra', tehsil: 'Palampur' })).toMatchObject({ town: 'Palampur' });
  });

  it('leaves an unknown town alone (validation will refuse it)', () => {
    const up = upgradeLegacyLocation({ town: 'Atlantis' }) as any;
    expect(up.district).toBeUndefined();
  });

  it('does not mutate its input, and tolerates non-objects', () => {
    const input = { town: 'Manali' };
    upgradeLegacyLocation(input);
    expect(input).toEqual({ town: 'Manali' });
    expect(upgradeLegacyLocation(null)).toBeNull();
    expect(upgradeLegacyLocation('x')).toBe('x');
  });
});

describe('assertLocationIsValid', () => {
  const ok = { district: 'Kullu', tehsil: 'Manali', lat: 32.2432, lng: 77.1892 };

  it('accepts a matching district, tehsil and a pin inside the state', () => {
    expect(() => assertLocationIsValid(ok)).not.toThrow();
  });

  it('accepts a pin anywhere in the state, not just near the chosen tehsil', () => {
    // A host may really be in a village far from the tehsil headquarters.
    expect(() => assertLocationIsValid({ ...ok, lat: 32.5534, lng: 76.1258 })).not.toThrow();
  });

  it('refuses a tehsil from another district', () => {
    expect(() => assertLocationIsValid({ ...ok, tehsil: 'Dharamshala' })).toThrow(/belongs to Kullu district/);
  });

  it('refuses an unknown district', () => {
    expect(() => assertLocationIsValid({ ...ok, district: 'Punjab' })).toThrow(BadRequestException);
  });

  it.each([
    ['Chandigarh', 30.7333, 76.7794],
    ['Pathankot', 32.2643, 75.6421],
    ['Jammu', 32.7266, 74.857],
    ['Dehradun', 30.3165, 78.0322],
  ])('refuses a pin in %s with a clear message', (_n, lat, lng) => {
    expect(() => assertLocationIsValid({ ...ok, lat, lng })).toThrow(/outside Himachal Pradesh/);
  });
});

describe('locationSchema', () => {
  const base = {
    district: 'Kullu', tehsil: 'Manali', town: 'Manali', streetAddress: 'Old Manali Road', city: 'Manali',
    state: 'Himachal Pradesh', pincode: '175131', lat: 32.2432, lng: 77.1892,
  };

  it('accepts a complete location', () => {
    expect(locationSchema.safeParse(base).success).toBe(true);
  });

  it('accepts any of the 12 districts and towns that were never in the old list of 18', () => {
    for (const [district, tehsil] of [['Hamirpur', 'Barsar'], ['Una', 'Amb'], ['Sirmaur', 'Nahan'], ['Bilaspur', 'Ghumarwin']]) {
      expect(locationSchema.safeParse({ ...base, district, tehsil, town: tehsil }).success).toBe(true);
    }
  });

  it('names the field when the district or tehsil is missing', () => {
    const noDistrict = locationSchema.safeParse({ ...base, district: undefined });
    expect(noDistrict.success).toBe(false);
    const noTehsil = locationSchema.safeParse({ ...base, tehsil: '' });
    expect(!noTehsil.success && noTehsil.error.issues[0].message).toBe('Choose the tehsil.');
  });

  it('refuses a district that is not in Himachal Pradesh', () => {
    expect(locationSchema.safeParse({ ...base, district: 'Ludhiana' }).success).toBe(false);
  });

  it('refuses a state other than Himachal Pradesh', () => {
    expect(locationSchema.safeParse({ ...base, state: 'Punjab' }).success).toBe(false);
  });
});
