export const CONSENT_CHECKER = Symbol('WHATSAPP_CONSENT_CHECKER');

/**
 * Narrow seam onto the contact_preferences service (channel 'whatsapp').
 * The real ConsentService can be bound to CONSENT_CHECKER later; the default denies everything.
 */
export interface ConsentChecker {
  /** True only when consent_status is 'granted' for this E.164 number on the whatsapp channel. */
  hasGrantedConsent(phoneE164: string): Promise<boolean>;
  /** Record a revocation (e.g. inbound STOP). */
  recordRevocation(phoneE164: string, source: string): Promise<void>;
}

export type SendOutcome =
  | { status: 'queued' | 'sent'; waMessageId: string; dryRun: boolean }
  | { status: 'blocked'; reason: string };

export const E164_REGEX = /^\+[1-9]\d{7,14}$/;

export const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

export const OPT_OUT_KEYWORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'opt out', 'optout'];
