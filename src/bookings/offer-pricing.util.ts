import { BadRequestException } from '@nestjs/common';
import { agreeTerms, PaymentMethod } from '../common/domain';

/** Host may move the computed total by at most this much (either way) unless an admin overrides. */
export const DEFAULT_OFFER_ADJUST_MAX_PCT = 25;
export const DEFAULT_OFFER_TTL_HOURS = 24;
export const MIN_OFFER_TTL_HOURS = 1;
export const MAX_OFFER_TTL_HOURS = 72;

export interface OfferListingPricing {
  dailyBaseRate: number;
  weeklyDiscountPct: number;
  monthlyDiscountPct: number;
  /** Optional flat per-stay fees from property_details; all integer rupees, default 0. */
  cleaningFee?: number;
  electricityCharge?: number;
  /** Per extra guest per night, above baseGuests. */
  extraGuestFee?: number;
  baseGuests?: number;
}

/** Everything the guest sees and pays, frozen on the offer. Integer rupees throughout. */
export interface PriceSnapshot {
  currency: 'INR';
  pricingMode: 'daily' | 'weekly' | 'monthly';
  /** Per-night (daily/weekly) or per-30-days (monthly) rate after discount. */
  rate: number;
  nights: number;
  subtotal: number;
  deposit: number;
  electricity: number;
  cleaning: number;
  extraGuest: number;
  /** Placeholder: no tax is collected yet. */
  taxes: number;
  /** Server-computed total from listing pricing. */
  computedTotal: number;
  /** What the guest pays: computedTotal, or the host's bounded adjustment of it. */
  hostAdjustedTotal: number;
  adjustmentPct: number;
}

const nonNegInt = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;

export function pricingFromPropertyDetails(pd: Record<string, any> | null | undefined): OfferListingPricing {
  const d = pd ?? {};
  const daily =
    typeof d.dailyBaseRate === 'number' ? d.dailyBaseRate : Math.round((d.price || d.monthlyRent || 12000) / 30);
  return {
    dailyBaseRate: daily,
    weeklyDiscountPct: d.weeklyDiscountPct ?? 15,
    monthlyDiscountPct: d.monthlyDiscountPct ?? 40,
    cleaningFee: nonNegInt(d.cleaningFee),
    electricityCharge: nonNegInt(d.electricityCharge),
    extraGuestFee: nonNegInt(d.extraGuestFee),
    baseGuests: typeof d.baseGuests === 'number' ? d.baseGuests : undefined,
  };
}

/** Pure, server-side. Nothing here is read from a client-supplied amount. */
export function computePriceSnapshot(
  pricing: OfferListingPricing,
  nights: number,
  partySize: number,
  paymentMethod: PaymentMethod = 'upi',
): PriceSnapshot {
  if (!Number.isInteger(nights) || nights < 1) throw new BadRequestException('Invalid stay length.');
  if (typeof pricing.dailyBaseRate !== 'number' || !Number.isFinite(pricing.dailyBaseRate) || pricing.dailyBaseRate < 0) {
    throw new BadRequestException('Listing is missing pricing information.');
  }
  const t = agreeTerms(pricing.dailyBaseRate, pricing.weeklyDiscountPct, pricing.monthlyDiscountPct, nights, paymentMethod);
  const pricingMode = nights >= 28 ? 'monthly' : nights >= 7 ? 'weekly' : 'daily';
  const rate =
    pricingMode === 'monthly'
      ? Math.round(pricing.dailyBaseRate * 30 * (1 - pricing.monthlyDiscountPct / 100))
      : pricingMode === 'weekly'
        ? Math.round(pricing.dailyBaseRate * (1 - pricing.weeklyDiscountPct / 100))
        : Math.round(pricing.dailyBaseRate);
  const baseGuests = pricing.baseGuests ?? Math.max(partySize, 1);
  const extraGuest = nonNegInt(pricing.extraGuestFee) * nights * Math.max(0, partySize - baseGuests);
  const electricity = nonNegInt(pricing.electricityCharge);
  const cleaning = nonNegInt(pricing.cleaningFee);
  const taxes = 0;
  const computedTotal = t.totalRent + t.deposit + electricity + cleaning + extraGuest + taxes;
  return {
    currency: 'INR',
    pricingMode,
    rate,
    nights,
    subtotal: t.totalRent,
    deposit: t.deposit,
    electricity,
    cleaning,
    extraGuest,
    taxes,
    computedTotal,
    hostAdjustedTotal: computedTotal,
    adjustmentPct: 0,
  };
}

export function offerBounds(computedTotal: number, maxPct: number): { min: number; max: number } {
  return {
    min: Math.ceil((computedTotal * (100 - maxPct)) / 100),
    max: Math.floor((computedTotal * (100 + maxPct)) / 100),
  };
}

/**
 * Applies the host's requested final total to a computed snapshot. Rejects
 * non-integers and totals outside +/- maxPct of the computed total unless
 * `adminOverride`. The adjustment lands on the rent component; deposit and
 * fees stay as computed, so the rent must stay positive.
 */
export function applyHostAdjustment(
  base: PriceSnapshot,
  requestedTotal: number | undefined | null,
  maxPct: number,
  adminOverride = false,
): PriceSnapshot {
  if (requestedTotal == null) return { ...base };
  if (!Number.isInteger(requestedTotal) || requestedTotal <= 0) {
    throw new BadRequestException('Offer total must be a whole number of rupees.');
  }
  const { min, max } = offerBounds(base.computedTotal, maxPct);
  if (!adminOverride && (requestedTotal < min || requestedTotal > max)) {
    throw new BadRequestException(
      `Offer total must be between ₹${min} and ₹${max} (±${maxPct}% of the computed price).`,
    );
  }
  const subtotal = base.subtotal + (requestedTotal - base.computedTotal);
  if (subtotal <= 0) throw new BadRequestException('Offer total is too low for this stay.');
  return {
    ...base,
    subtotal,
    hostAdjustedTotal: requestedTotal,
    adjustmentPct: Math.round(((requestedTotal - base.computedTotal) / base.computedTotal) * 1000) / 10,
  };
}

/** The booking money columns implied by a snapshot. due_at_move_in is what pay() charges. */
export function bookingAmountsFromSnapshot(s: PriceSnapshot, commissionPct: number) {
  const fees = s.electricity + s.cleaning + s.extraGuest;
  const gross = s.subtotal + fees;
  const commission = Math.round(gross * (commissionPct / 100));
  return {
    monthly_rent: gross,
    deposit: s.deposit,
    due_at_move_in: s.hostAdjustedTotal,
    gross_booking_amount: gross,
    platform_commission: commission,
    host_payout_amount: gross - commission,
  };
}

/** True when a stored snapshot is internally consistent (guards against a tampered/corrupt row). */
export function snapshotIsConsistent(s: PriceSnapshot): boolean {
  const parts = s.subtotal + s.deposit + s.electricity + s.cleaning + s.extraGuest + s.taxes;
  return s.currency === 'INR' && parts === s.hostAdjustedTotal && Number.isInteger(s.hostAdjustedTotal);
}
