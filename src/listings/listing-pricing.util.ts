export type PricingRow = {
  daily_rate: number;
  weekly_price: number | null;
  monthly_price: number | null;
  security_deposit: number | null;
  electricity_mode: 'included' | 'per_unit' | 'flat' | null;
  electricity_charge: number | null;
  cleaning_charge: number | null;
  extra_guest_fee: number | null;
  included_guests: number | null;
  utilities_included: string[];
  buffer_days: number;
};

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

/** Flattens the zod-validated property into the typed listing_pricing row. Money stays integer rupees. */
export function toPricingRow(p: Record<string, any>): PricingRow {
  return {
    daily_rate: Math.round(Number(p.dailyBaseRate)),
    weekly_price: n(p.weeklyPrice),
    monthly_price: n(p.monthlyPrice),
    security_deposit: n(p.securityDeposit),
    electricity_mode: p.electricityMode ?? null,
    electricity_charge: n(p.electricityCharge),
    cleaning_charge: n(p.cleaningCharge),
    extra_guest_fee: n(p.extraGuestFee),
    included_guests: n(p.includedGuests),
    utilities_included: Array.isArray(p.utilitiesIncluded) ? p.utilitiesIncluded : [],
    buffer_days: n(p.bufferDays) ?? 0,
  };
}

export const UPSERT_PRICING_SQL = `
INSERT INTO listing_pricing (listing_id, daily_rate, weekly_price, monthly_price, security_deposit,
  electricity_mode, electricity_charge, cleaning_charge, extra_guest_fee, included_guests,
  utilities_included, buffer_days, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
ON CONFLICT (listing_id) DO UPDATE SET
  daily_rate = EXCLUDED.daily_rate, weekly_price = EXCLUDED.weekly_price, monthly_price = EXCLUDED.monthly_price,
  security_deposit = EXCLUDED.security_deposit, electricity_mode = EXCLUDED.electricity_mode,
  electricity_charge = EXCLUDED.electricity_charge, cleaning_charge = EXCLUDED.cleaning_charge,
  extra_guest_fee = EXCLUDED.extra_guest_fee, included_guests = EXCLUDED.included_guests,
  utilities_included = EXCLUDED.utilities_included, buffer_days = EXCLUDED.buffer_days, updated_at = now()`;

export function pricingParams(listingId: string, r: PricingRow): unknown[] {
  return [
    listingId, r.daily_rate, r.weekly_price, r.monthly_price, r.security_deposit, r.electricity_mode,
    r.electricity_charge, r.cleaning_charge, r.extra_guest_fee, r.included_guests, r.utilities_included, r.buffer_days,
  ];
}
