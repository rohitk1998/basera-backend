import { ForbiddenException } from '@nestjs/common';

export type KycProfile = {
  selfie_uploaded_at: Date | null;
};

export type KycVerificationStatus = {
  identity: { status: string };
};

/**
 * The one account-level KYC gate, identical for guests (request-to-book) and
 * hosts (submit a listing): an approved identity document and an approved
 * live selfie, nothing else. "The gate is for the person, not the API" — call
 * this server-side wherever the action itself happens, not only from a
 * page-level redirect.
 *
 * Bank verification is deliberately not part of it: a guest pays through the
 * gateway and needs no bank account, and a host's payout account is checked
 * separately — admin approval of a listing going live still requires it
 * (see AdminService's banking layer), so no payout can reach an unverified
 * account. PAN is no longer required either.
 */
export function assertKycVerified(
  profile: KycProfile,
  verification: KycVerificationStatus,
): void {
  if (verification.identity.status !== 'verified') {
    throw new ForbiddenException('Verify your identity in Account & Profile to continue.');
  }
  if (!profile.selfie_uploaded_at) {
    throw new ForbiddenException('Take a live selfie in Account & Profile to continue.');
  }
}
