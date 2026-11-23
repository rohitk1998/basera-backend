export type Role = 'host' | 'admin';

export type LayerId = 'telemetry';
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
  listing_content: 'Photos / description / details',
  other: 'Other',
};

export type BookingStatus =
  | 'requested'
  | 'confirmed'
  | 'checked_in'
  | 'checked_out'
  | 'disputed'
  | 'completed'
  | 'declined'
  | 'cancelled'
  | 'expired';

export type PaymentMethod = 'upi' | 'cash';

/** Shortest stay RhenBasera accepts, in nights. Hosts may set a higher per-listing minimum, never a lower one. */
export const MIN_STAY_NIGHTS = 7;

/** The minimum a guest must book at a listing: the host's own minimum, floored at MIN_STAY_NIGHTS. */
export function effectiveMinStay(hostMinDays?: number | null): number {
  return Math.max(MIN_STAY_NIGHTS, typeof hostMinDays === 'number' && Number.isFinite(hostMinDays) ? hostMinDays : 0);
}

export type AgreedTerms = {
  totalRent: number;
  days: number;
  months: number | null;
  deposit: number;
  paymentMethod: PaymentMethod;
  dueAtMoveIn: number;
};

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
