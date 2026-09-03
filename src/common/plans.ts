// Ported from web/lib/plans.ts — same pattern as agreeTerms() above. Only
// what the backend needs to validate/price a subscription lives here (id,
// price); FEATURE_MATRIX/tagline copy stays frontend-only display detail.

export type PlanId = 'listed' | 'featured' | 'pro';

export const PLAN_PRICES: Record<PlanId, number> = {
  listed: 0,
  featured: 499,
  pro: 1299,
};

export function isPlanId(value: string): value is PlanId {
  return value === 'listed' || value === 'featured' || value === 'pro';
}
