export type CancellationPolicy = 'flexible' | 'moderate' | 'firm';

export const CANCELLATION_POLICIES: readonly CancellationPolicy[] = ['flexible', 'moderate', 'firm'];

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export interface RefundResult {
  /** Integer rupees returned to the guest. */
  refundAmount: number;
  /** Integer rupees the host keeps (paid - refund). */
  retainedAmount: number;
  /** 100 | 50 | 0 */
  refundPct: number;
  policy: CancellationPolicy;
  hoursBeforeCheckIn: number;
}

export function normalisePolicy(raw: unknown): CancellationPolicy {
  return CANCELLATION_POLICIES.includes(raw as CancellationPolicy) ? (raw as CancellationPolicy) : 'moderate';
}

/** Check-in is the start of move_in (YYYY-MM-DD) in IST, matching the rest of the app. */
export function checkInInstant(moveIn: string | Date): Date {
  return moveIn instanceof Date ? moveIn : new Date(`${moveIn}T00:00:00+05:30`);
}

/**
 * Refund tiers by how long before check-in the GUEST cancels (host cancellations
 * are always a full refund and never go through here).
 *   flexible: >= 24h 100%, inside 24h 50%
 *   moderate: >= 5 days 100%, inside 5 days 50%
 *   firm:     >= 14 days 100%, >= 48h 50%, inside 48h 0%
 * Pure: no clock, no IO. Money is integer rupees; the guest share rounds down.
 */
export function cancellationRefund(
  policy: CancellationPolicy | string | null | undefined,
  checkIn: string | Date,
  now: Date,
  paidAmount: number,
): RefundResult {
  const p = normalisePolicy(policy);
  const paid = Number.isFinite(paidAmount) && paidAmount > 0 ? Math.floor(paidAmount) : 0;
  const ms = checkInInstant(checkIn).getTime() - now.getTime();
  let pct: number;
  if (p === 'flexible') pct = ms >= DAY ? 100 : 50;
  else if (p === 'moderate') pct = ms >= 5 * DAY ? 100 : 50;
  else pct = ms >= 14 * DAY ? 100 : ms >= 48 * HOUR ? 50 : 0;
  const refundAmount = pct === 100 ? paid : Math.floor((paid * pct) / 100);
  return {
    refundAmount,
    retainedAmount: paid - refundAmount,
    refundPct: pct,
    policy: p,
    hoursBeforeCheckIn: Math.floor(ms / HOUR),
  };
}
