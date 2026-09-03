import { ForbiddenException } from '@nestjs/common';

export type VerifiableProfile = {
  kyc_completed_at: Date | null;
  selfie_uploaded_at: Date | null;
  bank_verified_at: Date | null;
};

/**
 * The single account-level verification gate — every consequential action
 * (guest request-to-book, host listing publish) checks the same three
 * fields on `profiles`. `requireHostKyc` is the only thing that differs by
 * role: HP Tourism registration/PAN (kyc_completed_at) stays host-only,
 * selfie and banking apply to both. "The gate is for the person, not the
 * API" — call this server-side wherever the action itself happens, not
 * only from a page-level redirect.
 */
export function assertVerified(
  profile: VerifiableProfile,
  opts: { requireHostKyc: boolean },
): void {
  if (opts.requireHostKyc && !profile.kyc_completed_at) {
    throw new ForbiddenException(
      'Complete your identity and Home Stay verification in Account & Profile before listing.',
    );
  }
  if (!profile.selfie_uploaded_at) {
    throw new ForbiddenException('Upload a selfie in Account & Profile to continue.');
  }
  if (!profile.bank_verified_at) {
    throw new ForbiddenException('Verify your bank account in Account & Profile to continue.');
  }
}
