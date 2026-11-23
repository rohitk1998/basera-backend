import { normalizeListingSearch, parsePriceRange } from './listing-search.util';

describe('phase 4 search params', () => {
  it('parses price, type, bedrooms and sort', () => {
    expect(normalizeListingSearch({ minPrice: '1000', maxPrice: '5000', propertyType: 'cabin', bedrooms: '2', sort: 'price_asc' })).toMatchObject({
      minPrice: 1000, maxPrice: 5000, propertyType: 'cabin', bedrooms: 2, sort: 'price_asc',
    });
  });
  it('drops junk and swaps a reversed range', () => {
    expect(normalizeListingSearch({ minPrice: 'abc', propertyType: "x'; drop", bedrooms: '-1', sort: 'random' })).toMatchObject({
      minPrice: undefined, propertyType: undefined, bedrooms: undefined, sort: undefined,
    });
    expect(parsePriceRange('9000', '2000')).toEqual({ minPrice: 2000, maxPrice: 9000 });
    expect(parsePriceRange('99999999', undefined).minPrice).toBe(1_000_000);
  });
  it('keeps sort=trust compatible', () => {
    const p = normalizeListingSearch({ sort: 'trust' });
    expect(p.sortByTrust).toBe(true);
    expect(p.sort).toBe('trust');
  });
});
