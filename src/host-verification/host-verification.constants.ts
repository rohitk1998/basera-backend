export const CONSENT_VERSION = 'dpdp-host-id-v1';

export const HOST_VERIFICATION_BUCKET = 'host-verification';
export const HOST_SELFIE_BUCKET = 'host-selfies';

export const ID_DOC_TYPES = ['driving_license', 'voter_id', 'passport', 'aadhaar_masked'] as const;
export type IdDocType = (typeof ID_DOC_TYPES)[number];

export const LIVENESS_CHALLENGES = ['blink_twice', 'turn_left', 'turn_right', 'smile'] as const;
export type LivenessChallenge = (typeof LIVENESS_CHALLENGES)[number];

export const REQUIRED_CHALLENGES = 2;
export const REQUIRED_FRAMES = 3;
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** Below this cosine similarity the admin sees a warning; the admin still decides. */
export const FACE_MATCH_WARN_BELOW = 0.35;

/** Liveness token lifetime: the host must finish the face check within this long of consent. */
export const LIVENESS_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Image safety: reject anything bigger than this many pixels before decoding (decompression bombs). */
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MIN_IMAGE_SIDE = 160;
export const REENCODE_MAX_SIDE = 2560;

/** Abuse limits: rejections in the window before the user is blocked, and the wait after each one. */
export const MAX_REJECTIONS_PER_WINDOW = 5;
export const ATTEMPT_WINDOW_DAYS = 30;
export const REJECTION_COOLDOWN_MS = 60 * 60 * 1000;

/** Review SLA: queue badge turns amber at SLA_WARN_HOURS and red at SLA_HOURS. */
export const SLA_WARN_HOURS = 24;
export const SLA_HOURS = 48;

/** Face scoring retries: cases stuck pending longer than this are re-scored by the sweep, up to the cap. */
export const FACE_STALE_MINUTES = 10;
export const FACE_MAX_AUTO_ATTEMPTS = 3;

export const MIN_HOST_AGE_YEARS = 18;

/**
 * Retention policy: a submitted case that nobody decides within this many days expires, its raw
 * files are purged by the sweep, and the host is told to resubmit. An abandoned (consented only)
 * case expires after 3 days.
 */
export const SUBMITTED_CASE_DAYS_TO_DECIDE = 7;
export const OPEN_CASE_DAYS_TO_START = 3;
