import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildTextCondition,
  canonicalDistrict,
  clampPagination,
  cleanText,
  escapeLike,
  normalizeListingSearch,
  parseCategory,
  queryWords,
} from './listing-search.util';

describe('escapeLike', () => {
  it('escapes %, _ and the backslash itself', () => {
    expect(escapeLike('100%_sure\\')).toBe('100\\%\\_sure\\\\');
  });
});

describe('cleanText', () => {
  it('trims, caps at 80 characters and takes the first of repeated values', () => {
    expect(cleanText('  kasol  ')).toBe('kasol');
    expect(cleanText('x'.repeat(200))).toHaveLength(80);
    expect(cleanText(['first', 'second'])).toBe('first');
    expect(cleanText([])).toBeUndefined();
    expect(cleanText('   ')).toBeUndefined();
    expect(cleanText({ a: 1 })).toBeUndefined();
    expect(cleanText(42)).toBeUndefined();
  });

  it('turns control characters into spaces', () => {
    expect(cleanText('a\u0000b')).toBe('a b');
  });
});

describe('district / category validation', () => {
  it('maps a district case-insensitively to its canonical name', () => {
    expect(canonicalDistrict('kullu')).toBe('Kullu');
    expect(canonicalDistrict('  LAHAUL   and spiti ')).toBe('Lahaul and Spiti');
  });

  it('drops anything that is not an HP district', () => {
    expect(canonicalDistrict('Atlantis')).toBeUndefined();
    expect(canonicalDistrict("Kullu'; drop table listings;--")).toBeUndefined();
    expect(canonicalDistrict('Kul')).toBeUndefined();
  });

  it('accepts only the five category ids', () => {
    for (const c of ['long', 'entire', 'work', 'views', 'quiet']) expect(parseCategory(c)).toBe(c);
    expect(parseCategory('luxury')).toBeUndefined();
    expect(parseCategory('WORK')).toBeUndefined();
    expect(parseCategory(['work', 'quiet'])).toBe('work');
  });
});

describe('clampPagination', () => {
  it('defaults to a bounded page when nothing is asked for', () => {
    expect(clampPagination(undefined, undefined)).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
    expect(DEFAULT_PAGE_SIZE).toBe(48);
  });

  it('clamps page >= 1 and pageSize to 1..200', () => {
    expect(clampPagination('0', '0')).toEqual({ page: 1, pageSize: 48 });
    expect(clampPagination('-3', '-10')).toEqual({ page: 1, pageSize: 48 });
    expect(clampPagination('abc', 'xyz')).toEqual({ page: 1, pageSize: 48 });
    expect(clampPagination('2', '1000')).toEqual({ page: 2, pageSize: MAX_PAGE_SIZE });
    expect(clampPagination('3', '7')).toEqual({ page: 3, pageSize: 7 });
    expect(clampPagination(['4', '5'], ['9'])).toEqual({ page: 4, pageSize: 9 });
    expect(clampPagination(Number.MAX_SAFE_INTEGER, 5).page).toBeLessThanOrEqual(100_000);
  });
});

describe('normalizeListingSearch', () => {
  it('reads q, and falls back to the old town / location names', () => {
    expect(normalizeListingSearch({ q: 'kasol' }).q).toBe('kasol');
    expect(normalizeListingSearch({ town: 'Manali' }).q).toBe('Manali');
    expect(normalizeListingSearch({ location: 'Bir' }).q).toBe('Bir');
    expect(normalizeListingSearch({ q: 'a', town: 'b', location: 'c' }).q).toBe('a');
  });

  it('does not throw on repeated params (?q=a&q=b) and uses the first value', () => {
    const p = normalizeListingSearch({ q: ['kasol', 'bir'], district: ['kullu', 'mandi'], category: ['work'], page: ['2'] });
    expect(p).toMatchObject({ q: 'kasol', district: 'Kullu', category: 'work', page: 2 });
  });

  it('ignores an invalid district or category instead of failing', () => {
    const p = normalizeListingSearch({ district: 'Narnia', category: 'beach', tehsil: ' ' });
    expect(p.district).toBeUndefined();
    expect(p.category).toBeUndefined();
    expect(p.tehsil).toBeUndefined();
  });

  it('validates dates, guests, sort and the facets flag', () => {
    const p = normalizeListingSearch({ date: '2026-10-05', dateEnd: '2026-02-31', guests: '3', sort: 'trust', facets: '1' });
    expect(p).toMatchObject({ moveIn: '2026-10-05', minGuests: 3, sortByTrust: true, facets: true });
    expect(p.moveOut).toBeUndefined();
    expect(normalizeListingSearch({ guests: '-2', facets: '0', sort: 'price' })).toMatchObject({
      minGuests: undefined,
      facets: false,
      sortByTrust: false,
    });
  });

  it('parses pets as a positive integer and drops anything else', () => {
    expect(normalizeListingSearch({ pets: '1' }).pets).toBe(1);
    expect(normalizeListingSearch({ pets: '0' }).pets).toBeUndefined();
    expect(normalizeListingSearch({ pets: 'x' }).pets).toBeUndefined();
    expect(normalizeListingSearch({ guests: '2' }).pets).toBeUndefined();
  });

  it('always returns bounded pagination', () => {
    expect(normalizeListingSearch({})).toMatchObject({ page: 1, pageSize: 48 });
    expect(normalizeListingSearch({ pageSize: '99999', page: '-1' })).toMatchObject({ page: 1, pageSize: 200 });
  });
});

describe('queryWords', () => {
  it('splits on whitespace and commas, lower-cases and caps the word count', () => {
    expect(queryWords('  Kasol,  KULLU  cottage ')).toEqual(['kasol', 'kullu', 'cottage']);
    expect(queryWords('a b c d e f g h i j')).toHaveLength(8);
    expect(queryWords('   ')).toEqual([]);
  });
});

describe('buildTextCondition', () => {
  it('is null for an empty query', () => {
    expect(buildTextCondition(undefined)).toBeNull();
    expect(buildTextCondition('  ,  ')).toBeNull();
  });

  it('matches a word prefix per field, never a bare substring and never the description', () => {
    const c = buildTextCondition('bir')!;
    expect(c.params).toMatchObject({ qs0: 'bir%', qw0: '% bir%' });
    expect(c.sql).not.toContain("'%bir%'");
    expect(c.sql).not.toContain('description');
    for (const f of ['title', 'town', 'tehsil', 'district', 'city', 'locality', 'streetAddress']) {
      expect(c.sql).toContain(`->>'${f}' ILIKE :qs0`);
    }
  });

  it('puts user input in bind parameters, escaped, never in the SQL text', () => {
    const c = buildTextCondition("50%_off\\'; drop table listings;--")!;
    expect(c.sql).not.toContain('drop table');
    expect(c.params.qs0).toBe("50\\%\\_off\\\\';%");
  });

  it('ANDs the words and ORs an alias hit with the plain text match', () => {
    const c = buildTextCondition('kasol cottage')!;
    expect(c.params).toMatchObject({ qad1: 'kullu', qat1: 'bhuntar' });
    expect(c.sql).toContain("lower(l.draft_data->'property_details'->>'district') = :qad1");
    expect(c.sql).toContain("lower(l.draft_data->'property_details'->>'tehsil') = :qat1");
    // two units (kasol, cottage) joined with AND
    expect(c.sql).toMatch(/\) AND \(\(/);
  });

  it('adds no alias branch for a word that is not a tourist name', () => {
    expect(Object.keys(buildTextCondition('cottage')!.params)).toEqual(['qs0', 'qw0']);
  });
});
