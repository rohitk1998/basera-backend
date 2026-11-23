import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { LIVENESS_CHALLENGES, type LivenessChallenge } from './host-verification.constants';

/** Key derived from the existing pepper so no new secret is needed; domain-separated from the ID hash. */
const deriveKey = (pepper: string): Buffer =>
  createHmac('sha256', pepper).update('rhenbasera:liveness:v1').digest();

export const newNonce = (): string => randomBytes(16).toString('hex');

/**
 * Two distinct challenges derived from the nonce by HMAC, never both head turns. The client cannot
 * choose them, and the same nonce always yields the same pair.
 */
export function challengesFor(nonce: string, pepper: string): [LivenessChallenge, LivenessChallenge] {
  const bytes = createHmac('sha256', deriveKey(pepper)).update(`challenges|${nonce}`).digest();
  const pool = [...LIVENESS_CHALLENGES];
  const first = pool.splice(bytes[0]! % pool.length, 1)[0]!;
  const rest = pool.filter((c) => !(first.startsWith('turn') && c.startsWith('turn')));
  return [first, rest[bytes[1]! % rest.length]!];
}

const sign = (caseId: string, userId: string, nonce: string, exp: number, pepper: string): string =>
  createHmac('sha256', deriveKey(pepper)).update(`token|${caseId}|${userId}|${nonce}|${exp}`).digest('base64url');

/** Token format: `<expiryMs>.<signature>`. Bound to case, user and nonce. */
export const issueLivenessToken = (caseId: string, userId: string, nonce: string, exp: number, pepper: string): string =>
  `${exp}.${sign(caseId, userId, nonce, exp, pepper)}`;

export function verifyLivenessToken(
  token: string | undefined,
  caseId: string,
  userId: string,
  nonce: string | null,
  pepper: string,
  now = Date.now(),
): 'ok' | 'invalid' | 'expired' {
  if (!token || !nonce) return 'invalid';
  const [expRaw, sig, ...extra] = token.split('.');
  const exp = Number(expRaw);
  if (!sig || extra.length || !Number.isFinite(exp)) return 'invalid';
  const want = Buffer.from(sign(caseId, userId, nonce, exp, pepper));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'invalid';
  return exp < now ? 'expired' : 'ok';
}
