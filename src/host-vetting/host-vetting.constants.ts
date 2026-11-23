export const RATING_SOURCES = ['google_maps', 'airbnb', 'booking', 'other'] as const;
export type RatingSource = (typeof RATING_SOURCES)[number];

export const AUDIT_OUTCOMES = ['pass', 'warn', 'fail'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const DEFAULT_MIN_RATING = 4.0;
export const DEFAULT_AUDIT_STALE_DAYS = 180;
export const DEFAULT_DUE_LIMIT = 100;
export const MAX_DUE_LIMIT = 500;
