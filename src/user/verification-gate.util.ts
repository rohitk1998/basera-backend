import { ForbiddenException } from '@nestjs/common';

export type KycProfile = {
  selfie_uploaded_at: Date | null;
};

export type KycVerificationStatus = {
  identity: { status: string };
};

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
