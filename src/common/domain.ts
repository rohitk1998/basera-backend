// Ported from web/lib/domain.ts — the service model behind the product.
// Money is stored in whole rupees as integers — never floats.

export type Role = 'host' | 'admin';

export type LayerId = 'legal' | 'telemetry' | 'banking';
export type LayerStatus = 'not_started' | 'submitted' | 'passed' | 'failed';

export type ListingStatus =
  | 'draft'
  | 'in_review'
  | 'changes_needed'
  | 'live'
  | 'paused'
  | 'rejected';

export type ReviewReasonCategory = LayerId | 'listing_content' | 'other';

export const REVIEW_REASON_LABEL: Record<ReviewReasonCategory, string> = {
  legal: 'Legal / registration',
  telemetry: 'Telemetry / walkthrough',
  banking: 'Banking / payout name',
  listing_content: 'Photos / description / details',
  other: 'Other',
};

export type BookingStatus =
  | 'requested'
  | 'confirmed'
  | 'checked_in'
  | 'disputed'
  | 'completed'
  | 'declined'
  | 'cancelled'
  | 'expired';

export type PaymentMethod = 'upi' | 'cash';

export type AgreedTerms = {
  totalRent: number;
  days: number;
  deposit: number;
  paymentMethod: PaymentMethod;
  dueAtMoveIn: number;
};

/**
 * Summarises what the two parties have agreed. No fee to the guest — this
 * figure is unchanged by the payment-hold model. Basera is funded by host
 * subscriptions (see subscriptions/), not a deduction from this total.
 */
export function agreeTerms(
  dailyBaseRate: number,
  weeklyDiscountPct: number,
  monthlyDiscountPct: number,
  days: number,
  paymentMethod: PaymentMethod = 'upi',
): AgreedTerms {
  let discount = 0;
  if (days >= 28) discount = monthlyDiscountPct / 100;
  else if (days >= 7) discount = weeklyDiscountPct / 100;
  const totalRent = Math.round(dailyBaseRate * days * (1 - discount));
  const deposit = days >= 28 ? Math.round(dailyBaseRate * 30 * (1 - monthlyDiscountPct/100)) : 0;
  return {
    totalRent,
    days,
    deposit,
    paymentMethod,
    dueAtMoveIn: totalRent + deposit,
  };
}
