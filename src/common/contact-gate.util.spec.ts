import { ForbiddenException } from '@nestjs/common';
import { assertVerifiedContact } from './contact-gate.util';

const base = { phone: null, email_verified_at: null, banned_at: null };

describe('assertVerifiedContact', () => {
  it('accepts a phone-verified guest', () => {
    expect(() => assertVerifiedContact({ ...base, phone: '+919800000000' })).not.toThrow();
  });
  it('accepts an email-verified international guest', () => {
    expect(() => assertVerifiedContact({ ...base, email_verified_at: new Date() })).not.toThrow();
  });
  it('rejects a guest with neither', () => {
    expect(() => assertVerifiedContact(base)).toThrow(ForbiddenException);
  });
  it('rejects a banned guest even when verified', () => {
    expect(() => assertVerifiedContact({ ...base, phone: '+919800000000', banned_at: new Date() })).toThrow(ForbiddenException);
  });
  it('rejects a missing account', () => {
    expect(() => assertVerifiedContact(null)).toThrow(ForbiddenException);
  });
});
