import { ForbiddenException } from '@nestjs/common';

export type HostIdProfile = { is_id_verified: boolean; banned_at: Date | null };

/** Hosts must pass the in-house ID check before a listing can be submitted. Guests never need it. */
export function assertHostIdVerified(profile: HostIdProfile): void {
  if (profile.banned_at) {
    throw new ForbiddenException('This account cannot list properties.');
  }
  if (!profile.is_id_verified) {
    throw new ForbiddenException('Verify your identity in Account & Profile to list a property.');
  }
}
