// Ported from web/lib/domain.ts — the service model behind the product.
// Money is stored in whole rupees as integers — never floats.

export type Role = 'host' | 'admin';

export type LayerId = 'telemetry' | 'banking';
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
  /** Whole months the rent is charged for on a monthly stay (28+ days); null
   *  for a shorter stay, which is charged per day. */
  months: number | null;
  deposit: number;
  paymentMethod: PaymentMethod;
  dueAtMoveIn: number;
};

/**
 * Summarises what the two parties have agreed. No fee to the guest — this
 * figure is unchanged by the payment-hold model. Basera's commission is
 * deducted from the host's payout, not added to this total.
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
  // A stay of a month or more is rented by the month, the way the search
  // results and listing cards price it ("₹X / month", "₹X for 2 months"):
  // 61 days is 2 months, not 61/30 of one. Shorter stays are per day.
  const monthlyRentAmount = Math.round(dailyBaseRate * 30 * (1 - monthlyDiscountPct / 100));
  const months = days >= 28 ? Math.max(1, Math.round(days / 30)) : null;
  const totalRent = months !== null ? monthlyRentAmount * months : Math.round(dailyBaseRate * days * (1 - discount));
  const deposit = days >= 28 ? monthlyRentAmount : 0;
  return {
    totalRent,
    days,
    months,
    deposit,
    paymentMethod,
    dueAtMoveIn: totalRent + deposit,
  };
}
