import { ForbiddenException } from '@nestjs/common';
import { assertHostIdVerified } from './host-id-gate.util';
import {
  FACE_MATCH_WARN_BELOW, ID_DOC_TYPES, LIVENESS_CHALLENGES, MAX_IMAGE_BYTES, REQUIRED_CHALLENGES, REQUIRED_FRAMES,
  SUBMITTED_CASE_DAYS_TO_DECIDE,
} from './host-verification.constants';
import { hashIdNumber, isPlausibleIdNumber, looksLikeAadhaarNumber, normalizeIdNumber } from './id-number.util';
import { sniffImage } from './image.util';
import { FaceMatchService } from './face-match.service';
import { challengesFor, issueLivenessToken, verifyLivenessToken } from './liveness-token.util';
import { PEPPER } from './host-verification.testkit';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

describe('constants', () => {
  it('are self-consistent', () => {
    expect(LIVENESS_CHALLENGES.length).toBeGreaterThanOrEqual(REQUIRED_CHALLENGES);
    expect(new Set(LIVENESS_CHALLENGES).size).toBe(LIVENESS_CHALLENGES.length);
    expect(new Set(ID_DOC_TYPES).size).toBe(ID_DOC_TYPES.length);
    expect(MAX_IMAGE_BYTES).toBeLessThanOrEqual(6291456); // storage bucket file_size_limit
    expect(REQUIRED_FRAMES).toBe(3);
    expect(SUBMITTED_CASE_DAYS_TO_DECIDE).toBe(7);
    expect(FACE_MATCH_WARN_BELOW).toBeGreaterThan(0);
  });
});

describe('id number utils (extra)', () => {
  it('is deterministic and hex sha256 sized', () => {
    const h = hashIdNumber(normalizeIdNumber('ab 12-345'), PEPPER);
    expect(h).toBe(hashIdNumber('AB12345', PEPPER));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it('plausibility bounds', () => {
    expect(isPlausibleIdNumber('ABCDE')).toBe(false);
    expect(isPlausibleIdNumber('ABCDEF')).toBe(true);
    expect(isPlausibleIdNumber('A'.repeat(25))).toBe(false);
  });
  it('a 12-digit Aadhaar number and a 16-digit Aadhaar VID are both refused', () => {
    expect(looksLikeAadhaarNumber('123456789012')).toBe(true);
    expect(looksLikeAadhaarNumber('1234567890123456')).toBe(true);
    expect(looksLikeAadhaarNumber('HP0120190001')).toBe(false);
  });
  it('KNOWN LIMIT: the same person on two doc types hashes differently (no cross-doc dedupe)', () => {
    expect(hashIdNumber('DL0120190001', PEPPER)).not.toBe(hashIdNumber('P1234567', PEPPER));
  });
});

describe('image sniffing (extra)', () => {
  it('accepts PNG and JPEG, rejects others', () => {
    expect(sniffImage(PNG)?.ext).toBe('png');
    expect(sniffImage(JPEG)?.ext).toBe('jpg');
    expect(sniffImage(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
  it('a truncated stub passes the sniff (the decode step in image.util.spec.ts rejects it)', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff]))).not.toBeNull();
  });
});

describe('assertHostIdVerified', () => {
  it('rules', () => {
    expect(() => assertHostIdVerified({ is_id_verified: true, banned_at: null })).not.toThrow();
    expect(() => assertHostIdVerified({ is_id_verified: false, banned_at: null })).toThrow(ForbiddenException);
    expect(() => assertHostIdVerified({ is_id_verified: true, banned_at: new Date() })).toThrow(/cannot list/);
  });
});

describe('liveness token', () => {
  const nonce = 'f'.repeat(32);
  it('is deterministic per nonce, two distinct challenges, never both head turns', () => {
    const a = challengesFor(nonce, PEPPER);
    expect(a).toEqual(challengesFor(nonce, PEPPER));
    expect(a[0]).not.toBe(a[1]);
    for (let i = 0; i < 200; i++) {
      const [x, y] = challengesFor(`n${i}`, PEPPER);
      expect(x.startsWith('turn') && y.startsWith('turn')).toBe(false);
    }
  });
  it('verifies only for its own case, user, nonce, secret, and before expiry', () => {
    const t = issueLivenessToken('c', 'u', nonce, Date.now() + 1000, PEPPER);
    expect(verifyLivenessToken(t, 'c', 'u', nonce, PEPPER)).toBe('ok');
    expect(verifyLivenessToken(t, 'c2', 'u', nonce, PEPPER)).toBe('invalid');
    expect(verifyLivenessToken(t, 'c', 'u2', nonce, PEPPER)).toBe('invalid');
    expect(verifyLivenessToken(t, 'c', 'u', 'x'.repeat(32), PEPPER)).toBe('invalid');
    expect(verifyLivenessToken(t, 'c', 'u', nonce, 'z'.repeat(40))).toBe('invalid');
    expect(verifyLivenessToken(t, 'c', 'u', nonce, PEPPER, Date.now() + 5000)).toBe('expired');
    expect(verifyLivenessToken('garbage', 'c', 'u', nonce, PEPPER)).toBe('invalid');
    expect(verifyLivenessToken(undefined, 'c', 'u', nonce, PEPPER)).toBe('invalid');
  });
});

describe('FaceMatchService', () => {
  const mk = (cfg: Record<string, string>) => new FaceMatchService({ get: (k: string) => cfg[k] } as never);
  afterEach(() => jest.restoreAllMocks());
  it('is unavailable (never a pass) with no worker, a 500, a network error, or junk body', async () => {
    expect(await mk({}).score(JPEG, [JPEG])).toEqual({ status: 'unavailable' });
    const f = jest.spyOn(global, 'fetch');
    f.mockResolvedValueOnce({ ok: false, status: 500 } as never);
    expect(await mk({ FACE_MATCH_URL: 'http://w' }).score(JPEG, [JPEG])).toEqual({ status: 'unavailable' });
    f.mockRejectedValueOnce(new Error('down'));
    expect(await mk({ FACE_MATCH_URL: 'http://w' }).score(JPEG, [JPEG])).toEqual({ status: 'unavailable' });
    f.mockResolvedValueOnce({ ok: true, json: async () => ({ similarity: 'x' }) } as never);
    expect(await mk({ FACE_MATCH_URL: 'http://w' }).score(JPEG, [JPEG])).toEqual({ status: 'unavailable' });
  });
  it('refuses a plain-http worker in production, allows it elsewhere', () => {
    expect(mk({ FACE_MATCH_URL: 'http://w', NODE_ENV: 'production' }).isConfigured()).toBe(false);
    expect(mk({ FACE_MATCH_URL: 'https://w', NODE_ENV: 'production' }).isConfigured()).toBe(true);
    expect(mk({ FACE_MATCH_URL: 'http://localhost:8000' }).isConfigured()).toBe(true);
  });
  it('clamps similarity', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, json: async () => ({ similarity: 7 }) } as never);
    expect(await mk({ FACE_MATCH_URL: 'http://w' }).score(JPEG, [JPEG])).toEqual({ status: 'scored', score: 1 });
  });
});
