import { pricingSchema, listingIssues } from './listing-schema';
import { toPricingRow } from './listing-pricing.util';

const base = {
  dailyBaseRate: '₹1,000',
  weeklyDiscountPct: 10,
  monthlyDiscountPct: 30,
  minDays: 7,
  availableFrom: '2030-01-01',
  billsIncluded: 'all',
};

describe('long-stay pricing', () => {
  it('parses absolute prices as integer rupees and defaults the lists', () => {
    const p = pricingSchema.parse({ ...base, weeklyPrice: '₹6,500', monthlyPrice: 24000.4, securityDeposit: '' });
    expect(p.weeklyPrice).toBe(6500);
    expect(p.monthlyPrice).toBe(24000);
    expect(p.securityDeposit).toBeUndefined();
    expect(p.utilitiesIncluded).toEqual([]);
    expect(p.bufferDays).toBe(0);
  });

  it('rejects unknown or duplicate utilities and out-of-range buffers', () => {
    expect(pricingSchema.safeParse({ ...base, utilitiesIncluded: ['water', 'jacuzzi'] }).success).toBe(false);
    expect(pricingSchema.safeParse({ ...base, utilitiesIncluded: ['water', 'water'] }).success).toBe(false);
    expect(pricingSchema.safeParse({ ...base, bufferDays: 4 }).success).toBe(false);
    expect(pricingSchema.safeParse({ ...base, bufferDays: 3, utilitiesIncluded: ['wifi', 'gas'] }).success).toBe(true);
  });

  it('rejects negative money', () => {
    expect(pricingSchema.safeParse({ ...base, cleaningCharge: -5 }).success).toBe(false);
  });

  it('weekly/monthly price may not exceed daily x 7 / x 30', () => {
    expect(listingIssues({ dailyBaseRate: 1000, weeklyPrice: 7000, monthlyPrice: 30000 })).toEqual({});
    expect(listingIssues({ dailyBaseRate: 1000, weeklyPrice: 7001 }).weeklyPrice).toMatch(/weekly price/i);
    expect(listingIssues({ dailyBaseRate: 1000, monthlyPrice: 30001 }).monthlyPrice).toMatch(/monthly price/i);
  });

  it('monthly per-day cannot exceed weekly per-day', () => {
    expect(listingIssues({ dailyBaseRate: 1000, weeklyPrice: 5000, monthlyPrice: 25000 }).monthlyPrice).toBeDefined();
  });

  it('electricity charge is required unless included; included guests <= max guests', () => {
    expect(listingIssues({ electricityMode: 'per_unit' }).electricityCharge).toBeDefined();
    expect(listingIssues({ electricityMode: 'flat', electricityCharge: 500 }).electricityCharge).toBeUndefined();
    expect(listingIssues({ electricityMode: 'included' }).electricityCharge).toBeUndefined();
    expect(listingIssues({ includedGuests: 5, maxGuests: 4 }).includedGuests).toBeDefined();
  });

  it('flattens to the typed row', () => {
    const row = toPricingRow({ dailyBaseRate: 1000, weeklyPrice: 6000, utilitiesIncluded: ['water'], bufferDays: 2 });
    expect(row).toMatchObject({ daily_rate: 1000, weekly_price: 6000, monthly_price: null, utilities_included: ['water'], buffer_days: 2 });
  });
});
