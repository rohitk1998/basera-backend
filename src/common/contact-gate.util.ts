import { ForbiddenException } from '@nestjs/common';

export type ContactGateUser = {
  phone: string | null;
  email_verified_at: Date | null;
  banned_at: Date | null;
};

/**
 * Gate for "Call Host" and booking holds. A guest qualifies with a verified phone
 * (Firebase OTP sets users.phone) or, for international guests, a verified email.
 * No government ID is ever asked for or stored for guests.
 */
export function assertVerifiedContact(user: ContactGateUser | null): void {
  if (!user) {
    throw new ForbiddenException('Log in to continue.');
  }
  if (user.banned_at) {
    throw new ForbiddenException('This account cannot contact hosts.');
  }
  if (!user.phone && !user.email_verified_at) {
    throw new ForbiddenException('Verify your mobile number or email to continue.');
  }
}
