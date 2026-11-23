/** Normalise an Indian-default phone to E.164, or null when it cannot be one. */
export function normalizePhone(raw?: string | null): string | null {
  if (!raw) return null;
  const s = raw.replace(/[\s().-]/g, '');
  let out: string;
  if (/^\+/.test(s)) out = s;
  else if (/^\d{10}$/.test(s)) out = `+91${s}`;
  else if (/^0\d{10}$/.test(s)) out = `+91${s.slice(1)}`;
  else if (/^91\d{10}$/.test(s)) out = `+${s}`;
  else return null;
  return /^\+[1-9]\d{7,14}$/.test(out) ? out : null;
}
