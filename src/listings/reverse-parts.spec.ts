import { matchDistrict, matchTehsil, partsFromGoogle, partsFromNominatim, streetFrom } from './reverse-parts';

const c = (long_name: string, ...types: string[]) => ({ long_name, short_name: long_name, types });

describe('matchDistrict', () => {
  it.each([
    ['Bilaspur', 'Bilaspur'],
    ['Bilaspur District', 'Bilaspur'],
    ['KANGRA', 'Kangra'],
    ['Lahul & Spiti', 'Lahaul and Spiti'],
    ['Lahaul and Spiti', 'Lahaul and Spiti'],
    ['Lahul and Spiti District', 'Lahaul and Spiti'],
    ['Sirmour', 'Sirmaur'],
    ['Sirmaur', 'Sirmaur'],
  ])('reads "%s" as %s', (input, expected) => expect(matchDistrict(input)).toBe(expected));

  it('does not guess at names outside Himachal Pradesh', () => {
    expect(matchDistrict('Ludhiana')).toBeUndefined();
    expect(matchDistrict('')).toBeUndefined();
    expect(matchDistrict(undefined)).toBeUndefined();
  });
});

describe('matchTehsil', () => {
  it('matches the exact name, ignoring case and a trailing "Tehsil"', () => {
    expect(matchTehsil('Bilaspur', 'Ghumarwin')).toBe('Ghumarwin');
    expect(matchTehsil('Bilaspur', 'GHUMARWIN Tehsil')).toBe('Ghumarwin');
  });

  it('only matches a tehsil that belongs to that district', () => {
    expect(matchTehsil('Kullu', 'Ghumarwin')).toBeUndefined();
  });

  it('accepts a name that uniquely starts a longer tehsil name', () => {
    expect(matchTehsil('Bilaspur', 'Naina Devi')).toBeUndefined(); // "Shri Naina Devi" does not start with it: leave to the host
    expect(matchTehsil('Mandi', 'Mandi')).toBe('Mandi Sadar');
  });

  it('refuses an ambiguous name rather than guessing (Shimla is both Urban and Rural)', () => {
    expect(matchTehsil('Shimla', 'Shimla')).toBeUndefined();
  });

  it('ignores very short names', () => {
    expect(matchTehsil('Kullu', 'Ku')).toBeUndefined();
  });
});

describe('streetFrom', () => {
  it('drops the state, PIN and country the form has its own fields for', () => {
    expect(streetFrom('NH103, Sohal, Ghumarwin, Himachal Pradesh 174021, India')).toBe('NH103, Sohal, Ghumarwin');
  });
  it('copes with nothing useful', () => {
    expect(streetFrom(undefined)).toBeUndefined();
    expect(streetFrom('Himachal Pradesh, India')).toBeUndefined();
  });
});

describe('partsFromGoogle', () => {
  // The spot in the bug report: a pin on NH103 near Sohal, Ghumarwin, Bilaspur.
  const ghumarwin = [
    {
      formatted_address: 'NH103, Sohal, Ghumarwin, Himachal Pradesh 174021, India',
      address_components: [
        c('NH103', 'route'),
        c('Sohal', 'sublocality_level_1', 'sublocality', 'political'),
        c('Ghumarwin', 'locality', 'political'),
        c('Ghumarwin', 'administrative_area_level_3', 'political'),
        c('Bilaspur', 'administrative_area_level_2', 'political'),
        c('Himachal Pradesh', 'administrative_area_level_1', 'political'),
        c('India', 'country', 'political'),
        c('174021', 'postal_code'),
      ],
    },
  ];

  it('fills every field the form has from one pin', () => {
    expect(partsFromGoogle(ghumarwin)).toEqual({
      district: 'Bilaspur',
      tehsil: 'Ghumarwin',
      city: 'Ghumarwin',
      locality: 'Sohal',
      pincode: '174021',
      street: 'NH103, Sohal, Ghumarwin',
    });
  });

  it('takes the PIN code from a later result when the first has none', () => {
    const first = { ...ghumarwin[0], address_components: ghumarwin[0].address_components.filter((x) => !x.types.includes('postal_code')) };
    const later = { address_components: [c('174021', 'postal_code')] };
    expect(partsFromGoogle([first, later]).pincode).toBe('174021');
  });

  it('leaves the tehsil out, not wrong, when no component matches this district', () => {
    const r = [{ address_components: [c('Bilaspur', 'administrative_area_level_2'), c('Some Village', 'locality')] }];
    const p = partsFromGoogle(r);
    expect(p.district).toBe('Bilaspur');
    expect(p.tehsil).toBeUndefined();
    expect(p.city).toBe('Some Village');
  });

  it('gives no district or tehsil for a place outside Himachal Pradesh', () => {
    const r = [{ address_components: [c('Ludhiana', 'administrative_area_level_2'), c('Ghumarwin', 'locality')] }];
    const p = partsFromGoogle(r);
    expect(p.district).toBeUndefined();
    expect(p.tehsil).toBeUndefined();
  });

  it('never repeats the city in the area field', () => {
    const r = [{ address_components: [c('Kullu', 'locality'), c('Kullu', 'sublocality_level_1')] }];
    expect(partsFromGoogle(r).locality).toBeUndefined();
  });

  it('handles no results', () => {
    expect(partsFromGoogle([])).toEqual({});
    expect(partsFromGoogle(undefined)).toEqual({});
  });

  it('ignores a PIN that is not six digits', () => {
    const r = [{ address_components: [c('1740', 'postal_code')] }];
    expect(partsFromGoogle(r).pincode).toBeUndefined();
  });
});

describe('partsFromNominatim (the fallback provider)', () => {
  it('reads the district, tehsil, village and PIN', () => {
    const p = partsFromNominatim(
      { village: 'Sohal', county: 'Ghumarwin Tehsil', state_district: 'Bilaspur', state: 'Himachal Pradesh', postcode: '174021' },
      'Sohal, Ghumarwin, Bilaspur, Himachal Pradesh, 174021, India',
    );
    expect(p).toMatchObject({ district: 'Bilaspur', tehsil: 'Ghumarwin', city: 'Sohal', pincode: '174021' });
  });

  it('still returns the street text when there are no address details', () => {
    expect(partsFromNominatim(undefined, 'Somewhere, Himachal Pradesh, India')).toEqual({ street: 'Somewhere' });
  });
});
