import { ConflictException } from '@nestjs/common';

export type BookingStatus =
  | 'requested'
  | 'host_review'
  | 'offered'
  | 'awaiting_payment'
  | 'confirmed'
  | 'checked_in'
  | 'checked_out'
  | 'disputed'
  | 'completed'
  | 'declined'
  | 'cancelled'
  | 'expired';

/**
 * The only legal booking status changes: from -> allowed targets.
 * Every status write in BookingsService goes through assertTransition, so a
 * new edge has to be added here (and reviewed) before any code can use it.
 */
export const BOOKING_TRANSITIONS: Readonly<
  Record<BookingStatus, readonly BookingStatus[]>
> = {
  // Offer flow: requested -> host_review (optional, host opened it) -> offered
  // (host sent a priced offer) -> awaiting_payment (guest accepted; dates held,
  // pay_by_at set) -> confirmed (payment verified via webhook / order check).
  // 'confirmed' straight from requested/host_review is the LEGACY approve()
  // path, which records an implicit, already-accepted offer.
  requested: ['host_review', 'offered', 'confirmed', 'declined', 'cancelled', 'expired'],
  host_review: ['offered', 'confirmed', 'declined', 'cancelled', 'expired'],
  offered: ['awaiting_payment', 'declined', 'cancelled', 'expired'],
  awaiting_payment: ['confirmed', 'cancelled', 'expired'],
  // 'expired' = host approved but the guest never paid within pay_by_at.
  confirmed: ['checked_in', 'cancelled', 'expired'],
  checked_in: ['disputed', 'checked_out', 'completed'],
  checked_out: ['completed'],
  disputed: ['completed'],
  completed: [],
  declined: [],
  cancelled: [],
  expired: [],
};

export function canTransition(from: string, to: string): boolean {
  const allowed = (BOOKING_TRANSITIONS as Record<string, readonly string[]>)[
    from
  ];
  return !!allowed && allowed.includes(to);
}

export function assertTransition(from: string, to: string): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(
      `Cannot move a booking from "${from}" to "${to}"`,
    );
  }
}
