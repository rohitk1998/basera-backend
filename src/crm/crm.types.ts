export const CONTACT_STATES = [
  'NOT_CONTACTED', 'CONTACT_ATTEMPTED', 'CONTACTED', 'INTERESTED', 'INVITED',
  'ONBOARDING', 'CONVERTED', 'DECLINED', 'DO_NOT_CONTACT',
] as const;
export type ContactState = (typeof CONTACT_STATES)[number];

export const LEAD_SOURCES = ['google_public', 'host_self_registered', 'referral', 'manual'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const OUTREACH_CHANNELS = ['call', 'email', 'whatsapp', 'sms', 'visit', 'self_registration'] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];

export const AUTOMATED_CHANNELS = ['email', 'whatsapp'] as const;

export type DiscoveryState =
  | 'DISCOVERED' | 'REVIEW_PENDING' | 'ELIGIBLE_FOR_OUTREACH' | 'CONTACT_IN_PROGRESS'
  | 'HOST_INTERESTED' | 'HOST_DECLINED' | 'CONVERTED_TO_PROPERTY' | 'ARCHIVED';

/**
 * Lead state matrix. CONVERTED is reachable ONLY through CrmService.markConverted (claim approved),
 * never through a manual update; DO_NOT_CONTACT is terminal (a re-opt-in must be a new, audited decision).
 */
export const CONTACT_TRANSITIONS: Record<ContactState, readonly ContactState[]> = {
  NOT_CONTACTED: ['CONTACT_ATTEMPTED', 'CONTACTED', 'INTERESTED', 'DECLINED', 'DO_NOT_CONTACT'],
  CONTACT_ATTEMPTED: ['CONTACT_ATTEMPTED', 'CONTACTED', 'INTERESTED', 'INVITED', 'DECLINED', 'DO_NOT_CONTACT'],
  CONTACTED: ['CONTACT_ATTEMPTED', 'CONTACTED', 'INTERESTED', 'INVITED', 'DECLINED', 'DO_NOT_CONTACT'],
  INTERESTED: ['CONTACTED', 'INTERESTED', 'INVITED', 'ONBOARDING', 'DECLINED', 'DO_NOT_CONTACT'],
  INVITED: ['CONTACTED', 'INTERESTED', 'INVITED', 'ONBOARDING', 'DECLINED', 'DO_NOT_CONTACT'],
  ONBOARDING: ['INVITED', 'ONBOARDING', 'CONVERTED', 'DECLINED', 'DO_NOT_CONTACT'],
  CONVERTED: ['DO_NOT_CONTACT'],
  DECLINED: ['CONTACTED', 'INTERESTED', 'DO_NOT_CONTACT'],
  DO_NOT_CONTACT: [],
};

export function canTransition(from: ContactState, to: ContactState): boolean {
  return from === to || CONTACT_TRANSITIONS[from].includes(to);
}

/** Which discovery_state a lead state maps to, and the discovery states it may move FROM. */
export const DISCOVERY_MAP: Partial<Record<ContactState, { to: DiscoveryState; from: DiscoveryState[] }>> = {
  CONTACT_ATTEMPTED: { to: 'CONTACT_IN_PROGRESS', from: ['ELIGIBLE_FOR_OUTREACH', 'CONTACT_IN_PROGRESS'] },
  CONTACTED: { to: 'CONTACT_IN_PROGRESS', from: ['ELIGIBLE_FOR_OUTREACH', 'CONTACT_IN_PROGRESS'] },
  INTERESTED: { to: 'HOST_INTERESTED', from: ['ELIGIBLE_FOR_OUTREACH', 'CONTACT_IN_PROGRESS', 'HOST_INTERESTED', 'HOST_DECLINED'] },
  INVITED: { to: 'HOST_INTERESTED', from: ['ELIGIBLE_FOR_OUTREACH', 'CONTACT_IN_PROGRESS', 'HOST_INTERESTED'] },
  ONBOARDING: { to: 'HOST_INTERESTED', from: ['ELIGIBLE_FOR_OUTREACH', 'CONTACT_IN_PROGRESS', 'HOST_INTERESTED'] },
  DECLINED: { to: 'HOST_DECLINED', from: ['ELIGIBLE_FOR_OUTREACH', 'CONTACT_IN_PROGRESS', 'HOST_INTERESTED'] },
  DO_NOT_CONTACT: { to: 'HOST_DECLINED', from: ['ELIGIBLE_FOR_OUTREACH', 'CONTACT_IN_PROGRESS', 'HOST_INTERESTED'] },
  CONVERTED: {
    to: 'CONVERTED_TO_PROPERTY',
    from: ['ELIGIBLE_FOR_OUTREACH', 'CONTACT_IN_PROGRESS', 'HOST_INTERESTED', 'HOST_DECLINED', 'DISCOVERED', 'REVIEW_PENDING'],
  },
};

/** Timestamp column stamped (once) the first time a lead reaches each funnel stage. */
export const STAGE_COLUMN: Partial<Record<ContactState, string>> = {
  CONTACT_ATTEMPTED: 'first_contacted_at', // attempted counts as first touch
  CONTACTED: 'first_contacted_at',
  INTERESTED: 'interested_at',
  INVITED: 'invited_at',
  ONBOARDING: 'onboarding_at',
  CONVERTED: 'converted_at',
  DECLINED: 'declined_at',
};

export interface FunnelCounts {
  total: number;
  contacted: number;
  interested: number;
  invited: number;
  converted: number;
}
export interface Rate { numerator: number; denominator: number; rate: number | null }
export function rate(numerator: number, denominator: number): Rate {
  return { numerator, denominator, rate: denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : null };
}
export function computeFunnel(c: FunnelCounts) {
  return {
    contactRate: rate(c.contacted, c.total),
    interestRate: rate(c.interested, c.contacted),
    inviteRate: rate(c.invited, c.interested),
    conversionOfInvited: rate(c.converted, c.invited),
    overallConversion: rate(c.converted, c.total),
  };
}
