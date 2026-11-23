import { createHash, randomBytes } from 'crypto';

/** 32 random bytes, base64url (43 chars, URL-safe). Only the SHA-256 hash is ever stored. */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export function claimUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}/claim?token=${token}`;
}
