import { buildWhatsappUrl, normaliseWhatsappNumber } from './whatsapp-link.util';

describe('normaliseWhatsappNumber', () => {
  it('adds +91 to a bare 10-digit number', () => {
    expect(normaliseWhatsappNumber('98000 00000')).toBe('919800000000');
  });
  it('keeps +91 numbers and strips punctuation', () => {
    expect(normaliseWhatsappNumber('+91-98000-00000')).toBe('919800000000');
  });
  it('drops a leading trunk 0', () => {
    expect(normaliseWhatsappNumber('09800000000')).toBe('919800000000');
  });
  it('keeps other country codes and handles 00 prefix', () => {
    expect(normaliseWhatsappNumber('+44 7911 123456')).toBe('447911123456');
    expect(normaliseWhatsappNumber('0044 7911 123456')).toBe('447911123456');
  });
  it('rejects empty or implausible input', () => {
    expect(normaliseWhatsappNumber(null)).toBeNull();
    expect(normaliseWhatsappNumber('abc')).toBeNull();
    expect(normaliseWhatsappNumber('12345')).toBeNull();
    expect(normaliseWhatsappNumber('1'.repeat(16))).toBeNull();
  });
});

describe('buildWhatsappUrl', () => {
  it('builds a wa.me link with an encoded message naming the listing and RhenBasera', () => {
    const url = buildWhatsappUrl('9800000000', 'Cosy & quiet cottage')!;
    expect(url.startsWith('https://wa.me/919800000000?text=')).toBe(true);
    const text = decodeURIComponent(url.split('?text=')[1]);
    expect(text).toContain('Cosy & quiet cottage');
    expect(text).toContain('RhenBasera');
    expect(url).not.toContain(' ');
  });
  it('returns null for an unusable phone', () => {
    expect(buildWhatsappUrl('nope', 'x')).toBeNull();
  });
  it('falls back when the title is blank', () => {
    expect(decodeURIComponent(buildWhatsappUrl('9800000000', '  ')!)).toContain('your stay');
  });
});
