export const CLAIM_STATES = [
  'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUIRED', 'APPROVED', 'REJECTED', 'WITHDRAWN',
] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

/** States in which a claim is still "open" (unique per listing+claimant). */
export const OPEN_STATES: readonly ClaimState[] = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUIRED'];
/** Open states that an admin must decide (claimant has submitted). */
export const REVIEWABLE_STATES: readonly ClaimState[] = ['SUBMITTED', 'UNDER_REVIEW'];
/** States in which the claimant may still edit and upload. */
export const EDITABLE_STATES: readonly ClaimState[] = ['DRAFT', 'MORE_INFORMATION_REQUIRED'];
export const WITHDRAWABLE_STATES: readonly ClaimState[] = OPEN_STATES;

export const CLAIM_ROLES = ['owner', 'manager'] as const;
export type ClaimRole = (typeof CLAIM_ROLES)[number];

export const EVIDENCE_KINDS = [
  'business_registration', 'ownership_document', 'management_agreement', 'utility_bill', 'property_photo', 'other',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
/** Kinds that count towards the "at least one document" submit minimum (photos alone are not proof). */
export const DOCUMENT_KINDS: readonly EvidenceKind[] = EVIDENCE_KINDS.filter((k) => k !== 'property_photo');

export const CLAIM_EVIDENCE_BUCKET = 'claim-evidence';
export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
export const EVIDENCE_MAX_FILES_PER_CLAIM = 10;
export const EVIDENCE_SIGNED_URL_TTL_SECONDS = 120;
export const EVIDENCE_RETENTION_DAYS = 180;
export const CURRENT_CLAIM_TERMS_VERSION = '2026-11';
export const MIN_AUTHORITY_STATEMENT = 20;

/** Allowed mime types and the file signature each must start with (server-sniffed, never trusted from the client). */
export const EVIDENCE_MIME: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  'application/pdf': { ext: 'pdf', magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': {
    ext: 'webp',
    magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
};
