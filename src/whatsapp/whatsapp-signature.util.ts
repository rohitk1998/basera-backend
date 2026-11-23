import { createHmac, timingSafeEqual } from 'crypto';

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Verify Meta's X-Hub-Signature-256 ("sha256=<hex>") over the raw body. */
export function verifyMetaSignature(raw: Buffer | undefined, header: string | undefined, appSecret: string): boolean {
  if (!raw || !header || !appSecret) return false;
  const expected = 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex');
  return safeEqual(expected, header);
}
