import { BadRequestException } from '@nestjs/common';
import {
  applyHostAdjustment,
  bookingAmountsFromSnapshot,
  computePriceSnapshot,
  offerBounds,
  snapshotIsConsistent,
} from './offer-pricing.util';

const pricing = { dailyBaseRate: 1000, weeklyDiscountPct: 15, monthlyDiscountPct: 40, cleaningFee: 300, electricityCharge: 200 };

describe('computePriceSnapshot', () => {
  it('daily stay: rate x nights + fees, integer rupees', () => {
    const s = computePriceSnapshot(pricing, 3, 2);
    expect(s).toMatchObject({ pricingMode: 'daily', rate: 1000, nights: 3, subtotal: 3000, deposit: 0, cleaning: 300, electricity: 200, currency: 'INR' });
    expect(s.computedTotal).toBe(3500);
    expect(s.hostAdjustedTotal).toBe(3500);
    expect(snapshotIsConsistent(s)).toBe(true);
  });
  it('weekly and monthly pricing modes use the discounted rates and monthly takes a deposit', () => {
    expect(computePriceSnapshot(pricing, 7, 1)).toMatchObject({ pricingMode: 'weekly', rate: 850, subtotal: 5950 });
    const m = computePriceSnapshot(pricing, 30, 1);
    expect(m).toMatchObject({ pricingMode: 'monthly', rate: 18000, subtotal: 18000, deposit: 18000 });
    expect(Number.isInteger(m.computedTotal)).toBe(true);
  });
  it('charges extra guests above baseGuests per night', () => {
    const s = computePriceSnapshot({ ...pricing, extraGuestFee: 100, baseGuests: 2 }, 2, 4);
    expect(s.extraGuest).toBe(400);
  });
  it('rejects invalid nights', () => {
    expect(() => computePriceSnapshot(pricing, 0, 1)).toThrow(BadRequestException);
  });
});

describe('applyHostAdjustment (bounds)', () => {
  const base = computePriceSnapshot(pricing, 3, 1); // 3500
  it('bounds are +/- pct of the computed total', () => {
    expect(offerBounds(3500, 25)).toEqual({ min: 2625, max: 4375 });
  });
  it('accepts totals inside the band and moves only the rent', () => {
    const s = applyHostAdjustment(base, 4000, 25);
    expect(s).toMatchObject({ hostAdjustedTotal: 4000, subtotal: 3500, computedTotal: 3500, adjustmentPct: 14.3 });
    expect(snapshotIsConsistent(s)).toBe(true);
  });
  it('rejects totals outside the band, floats and non-positive numbers', () => {
    expect(() => applyHostAdjustment(base, 4376, 25)).toThrow(BadRequestException);
    expect(() => applyHostAdjustment(base, 2624, 25)).toThrow(BadRequestException);
    expect(() => applyHostAdjustment(base, 3500.5, 25)).toThrow(BadRequestException);
    expect(() => applyHostAdjustment(base, 0, 25)).toThrow(BadRequestException);
  });
  it('admin override lifts the band but not the sanity floor', () => {
    expect(applyHostAdjustment(base, 9000, 25, true).hostAdjustedTotal).toBe(9000);
    expect(() => applyHostAdjustment(base, 400, 25, true)).toThrow(BadRequestException); // rent would go <= 0
  });
  it('undefined keeps the computed price', () => {
    expect(applyHostAdjustment(base, undefined, 25).hostAdjustedTotal).toBe(3500);
  });
});

describe('bookingAmountsFromSnapshot / tamper detection', () => {
  it('derives commission and payout from the snapshot total', () => {
    const s = applyHostAdjustment(computePriceSnapshot(pricing, 3, 1), 4000, 25);
    const a = bookingAmountsFromSnapshot(s, 6);
    expect(a.due_at_move_in).toBe(4000);
    expect(a.gross_booking_amount).toBe(4000);
    expect(a.platform_commission + a.host_payout_amount).toBe(a.gross_booking_amount);
  });
  it('flags a snapshot whose parts no longer add up', () => {
    const s = computePriceSnapshot(pricing, 3, 1);
    expect(snapshotIsConsistent({ ...s, hostAdjustedTotal: s.hostAdjustedTotal - 500 })).toBe(false);
    expect(snapshotIsConsistent({ ...s, currency: 'USD' as never })).toBe(false);
  });
});
