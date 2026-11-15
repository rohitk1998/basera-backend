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
