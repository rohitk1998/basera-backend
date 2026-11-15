import { hashIdNumber, isPlausibleIdNumber, looksLikeAadhaarNumber, normalizeIdNumber } from './id-number.util';

describe('id number utils', () => {
  it('normalises formatting so the same ID always hashes the same', () => {
    expect(normalizeIdNumber('dl-01 2019/0001')).toBe('DL0120190001');
    const pepper = 'p'.repeat(32);
    expect(hashIdNumber(normalizeIdNumber('dl-01 2019/0001'), pepper)).toBe(hashIdNumber('DL0120190001', pepper));
  });

  it('changes the hash with the pepper', () => {
    expect(hashIdNumber('ABC12345', 'a'.repeat(32))).not.toBe(hashIdNumber('ABC12345', 'b'.repeat(32)));
  });

  it('flags a 12-digit run as an Aadhaar number', () => {
    expect(looksLikeAadhaarNumber(normalizeIdNumber('1234 5678 9012'))).toBe(true);
    expect(looksLikeAadhaarNumber('DL0120190001')).toBe(false);
  });

  it('rejects implausibly short or long values', () => {
    expect(isPlausibleIdNumber('AB12')).toBe(false);
    expect(isPlausibleIdNumber('A'.repeat(25))).toBe(false);
    expect(isPlausibleIdNumber('K1234567')).toBe(true);
  });
});
