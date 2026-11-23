import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import type { InquiryState } from './inquiry.types';

/** Guest must hear back (first staff response) within this window; the sweep expires inquiries that miss it. */
export const INQUIRY_RESPONSE_WINDOW_MS = 24 * 3600 * 1000;
/** Requests about one discovered property wait longer: the admin has to reach and onboard the owner. */
export const RESPONSE_WINDOW_CANDIDATE_MS = 7 * 24 * 3600 * 1000;
export function responseWindowMs(hasCandidate: boolean): number {
  return hasCandidate ? RESPONSE_WINDOW_CANDIDATE_MS : INQUIRY_RESPONSE_WINDOW_MS;
}
/** Same contact + target + dates inside this window returns the existing inquiry. */
export const INQUIRY_DEDUPE_WINDOW_MS = 24 * 3600 * 1000;
export const INQUIRY_CONSENT_VERSION = 'inquiry-consent-v1';
export const INQUIRY_MAX_NIGHTS = 60;
export const INQUIRY_MAX_ADVANCE_DAYS = 400;

export const TERMINAL_STATES: readonly InquiryState[] = ['CONVERTED', 'DECLINED', 'EXPIRED', 'CLOSED'];
/** States the admin can still act on. */
export const ACTIVE_STATES: readonly InquiryState[] = ['NEW', 'ASSIGNED', 'HOST_CONTACTING'];
/** Active plus legacy states from the old 10-state flow: only the expiry sweep and not-available act on these. */
export const SWEEPABLE_STATES: readonly InquiryState[] = [...ACTIVE_STATES, 'HOST_RESPONDED', 'OFFER_PENDING', 'OFFER_SENT'];

/** Allowed transitions. CONVERTED is reachable only through send-to-owner (creates the booking request). */
export const TRANSITIONS: Record<InquiryState, readonly InquiryState[]> = {
  NEW: ['ASSIGNED', 'HOST_CONTACTING', 'CONVERTED', 'DECLINED', 'EXPIRED'],
  ASSIGNED: ['HOST_CONTACTING', 'CONVERTED', 'DECLINED', 'EXPIRED'],
  HOST_CONTACTING: ['CONVERTED', 'DECLINED', 'EXPIRED'],
  HOST_RESPONDED: ['DECLINED', 'EXPIRED'],
  OFFER_PENDING: ['DECLINED', 'EXPIRED'],
  OFFER_SENT: ['DECLINED', 'EXPIRED'],
  CONVERTED: [],
  DECLINED: [],
  EXPIRED: [],
  CLOSED: [],
};

export function canTransition(from: InquiryState, to: InquiryState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export type GuestStatus = 'received' | 'sent_to_owner' | 'unavailable' | 'expired' | 'closed';

/** Internal states collapse to a guest-safe vocabulary. */
export function guestStatus(state: InquiryState, hasCandidate = false): GuestStatus {
  switch (state) {
    // The guest keeps seeing "received" for the whole time we are contacting and onboarding the owner. It only
    // changes when the request reaches the owner (sent_to_owner) or is turned down (unavailable).
    case 'NEW':
    case 'ASSIGNED':
    case 'HOST_CONTACTING':
    case 'HOST_RESPONDED':
    case 'OFFER_PENDING':
    case 'OFFER_SENT':
      return 'received';
    case 'CONVERTED':
      return 'sent_to_owner';
    case 'DECLINED':
      return 'unavailable';
    case 'EXPIRED':
      return hasCandidate ? 'unavailable' : 'expired';
    default:
      return 'closed';
  }
}

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PUBLIC_REF_RE = /^RQ-[A-Z0-9]{6}$/;

export function generatePublicRef(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `RQ-${s}`;
}

export function generateAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenMatches(token: string | undefined, storedHash: string): boolean {
  if (!token || token.length < 20 || token.length > 100) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface DedupeParts {
  phone: string;
  email?: string | null;
  targetListingId?: string | null;
  destination?: string | null;
  checkIn?: string | null;
  checkOut?: string | null;
}

/** Stable hash of contact + target + dates (no PII in the stored key). */
export function dedupeHash(p: DedupeParts): string {
  const norm = [
    p.phone.trim(),
    (p.email ?? '').trim().toLowerCase(),
    p.targetListingId ?? `d:${(p.destination ?? '').trim().toLowerCase().replace(/\s+/g, ' ')}`,
    p.checkIn ?? '',
    p.checkOut ?? '',
  ].join('|');
  return createHash('sha256').update(norm).digest('hex').slice(0, 40);
}

/** Unique key = hash + 24h bucket; the sliding-window lookup uses the hash prefix. */
export function dedupeKey(hash: string, now: Date): string {
  return `${hash}:${Math.floor(now.getTime() / INQUIRY_DEDUPE_WINDOW_MS)}`;
}

/** Returns an error message or null. `today` is YYYY-MM-DD. */
export function validateDates(checkIn: string | undefined | null, checkOut: string | undefined | null, now = new Date()): string | null {
  if (!checkIn && !checkOut) return null;
  if (!checkIn || !checkOut) return 'Provide both check-in and check-out, or neither.';
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 'Dates are invalid.';
  const todayUtc = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const DAY = 86_400_000;
  if (a < todayUtc - DAY) return 'Check-in cannot be in the past.';
  if (b <= a) return 'Check-out must be after check-in.';
  if ((b - a) / DAY > INQUIRY_MAX_NIGHTS) return `Stays longer than ${INQUIRY_MAX_NIGHTS} nights need a different request.`;
  if ((a - todayUtc) / DAY > INQUIRY_MAX_ADVANCE_DAYS) return 'Check-in is too far ahead.';
  return null;
}
