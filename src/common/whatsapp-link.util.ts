const DEFAULT_COUNTRY_CODE = '91';
const INDIAN_MOBILE_LENGTH = 10;
const MIN_INTERNATIONAL_DIGITS = 8;
const MAX_INTERNATIONAL_DIGITS = 15;

/**
 * Digits-only number with country code, or null when it cannot be a valid number.
 * 10-digit (or 0-prefixed 11-digit) numbers are treated as Indian; anything else
 * must already carry its country code.
 */
export function normaliseWhatsappNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (raw.trim().startsWith('00')) digits = digits.replace(/^00/, '');
  else if (digits.length === INDIAN_MOBILE_LENGTH + 1 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === INDIAN_MOBILE_LENGTH) digits = DEFAULT_COUNTRY_CODE + digits;
  if (digits.length < MIN_INTERNATIONAL_DIGITS || digits.length > MAX_INTERNATIONAL_DIGITS) return null;
  return digits;
}

export function buildWhatsappUrl(phone: string | null | undefined, listingTitle: string): string | null {
  const digits = normaliseWhatsappNumber(phone);
  if (!digits) return null;
  const title = listingTitle.trim() || 'your stay';
  const message = `Hi, I found "${title}" on RhenBasera and I'd like to ask about it.`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
