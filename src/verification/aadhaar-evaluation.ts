import type { AadhaarSideResult } from '../payments/cashfree.service';

/**
 * Loose "same person" check between two names: every word of the shorter name
 * must appear in the longer one, with a single initial allowed to stand for a
 * full word ("A K Rao" ~ "Asha Kumari Rao"). Case and punctuation are ignored.
 */
export function namesMatch(a: string, b: string): boolean {
  const words = (n: string) => n.toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const [short, long] = [words(a), words(b)].sort((x, y) => x.length - y.length);
  if (short.length === 0) return false;
  const pool = [...long];
  return short.every((w) => {
    const i = pool.findIndex(
      (p) => p === w || (w.length === 1 && p.startsWith(w)) || (p.length === 1 && w.startsWith(p)),
    );
    if (i === -1) return false;
    pool.splice(i, 1);
    return true;
  });
}

export type AadhaarDecision =
  | { decision: 'verified'; summary: AadhaarSummary }
  /** Refused: the user gets `reason` and can upload again. Nobody reviews it by hand. */
  | { decision: 'rejected'; reason: string; summary: AadhaarSummary };

/** The only OCR facts kept after a check — never the number, address, photo or hashes. */
export interface AadhaarSummary {
  source: 'cashfree-smart-ocr';
  referenceIds: string[];
  qrStatus: string;
  uidLast4: string | null;
  flags: string[];
}

const FRAUD_LABELS: Record<string, string> = {
  is_screenshot: 'screenshot',
  is_photo_of_screen: 'photo of a screen',
  is_photo_imposed: 'photo imposed',
  is_overwritten: 'overwritten text',
  is_forged: 'forged',
};

const QUALITY_LABELS: Record<string, string> = {
  blur: 'blurry',
  glare: 'glare',
  partially_present: 'card partly out of frame',
  obscured: 'card partly covered',
};

const RETAKE = 'Retake the photo in good light with the whole card in frame, no glare or blur.';
const QR_HELP =
  'We could not verify the QR code on your Aadhaar. Make sure the QR code is fully visible and sharp on both sides. ' +
  'Older cards without a signed QR cannot be verified — download your current e-Aadhaar from myaadhaar.uidai.gov.in and upload that.';

/**
 * Turns the two Smart OCR results (front and back of one Aadhaar) into a
 * decision. Cashfree's own `valid` flag is not trusted on its own — the API
 * can report a screenshot as valid — so quality, fraud and consistency are
 * evaluated here:
 *
 *  - any fraud flag, or an unreadable / poor-quality side  -> rejected
 *  - the two uploads are the same side, not front + back   -> rejected
 *  - names / last four digits disagree between card, QR and profile -> rejected
 *  - anything that cannot be confirmed (QR not UIDAI-signed, missing fields) -> rejected,
 *    with what to do about it: there is no manual fallback
 *  - everything clean AND a UIDAI-signed QR                -> verified
 */
export function evaluateAadhaar(
  first: AadhaarSideResult,
  second: AadhaarSideResult,
  profileName: string,
): AadhaarDecision {
  const sides = [first, second];
  const summary: AadhaarSummary = {
    source: 'cashfree-smart-ocr',
    referenceIds: sides.map((s) => s.referenceId).filter(Boolean),
    qrStatus: 'NOT_PRESENT',
    uidLast4: null,
    flags: [],
  };
  const reject = (reason: string): AadhaarDecision => ({ decision: 'rejected', reason, summary });

  // 1. Unreadable file.
  if (sides.some((s) => !s.valid)) {
    return reject(`We could not read your Aadhaar. ${RETAKE}`);
  }

  // 2. Fraud signals on either side.
  for (const s of sides) {
    const hit = Object.keys(FRAUD_LABELS).find((k) => s.fraud[k] === true);
    if (hit) {
      summary.flags.push(`fraud:${hit}`);
      return reject(
        `This looks like a ${FRAUD_LABELS[hit]}, not a photo of your original card. Upload a fresh photo of the physical card.`,
      );
    }
  }

  // 3. Front + back, once each. Their order does not matter.
  const front = sides.find((s) => s.side === 'front');
  const back = sides.find((s) => s.side === 'back');
  if (!front || !back || front === back) {
    return reject('Upload one photo of the front and one of the back of your Aadhaar — we received the same side twice.');
  }

  // 4. Photo quality.
  for (const s of [front, back]) {
    const hit = Object.keys(QUALITY_LABELS).find((k) => s.quality[k] === true);
    if (hit) {
      summary.flags.push(`quality:${hit}`);
      return reject(`The ${s === front ? 'front' : 'back'} photo is unclear (${QUALITY_LABELS[hit]}). ${RETAKE}`);
    }
  }
  if (front.quality.face_present === false || front.quality.face_clear === false) {
    summary.flags.push('quality:face');
    return reject(`Your face is not clearly visible on the front of the card. ${RETAKE}`);
  }

  // 5. What the card says.
  const printedName = front.fields.name;
  const uid = front.fields.uid;
  if (!printedName) {
    summary.flags.push('name-unreadable');
    return reject(`We could not read the name on the front of your Aadhaar. ${RETAKE}`);
  }
  if (!namesMatch(profileName, printedName)) {
    return reject('The name on your Aadhaar does not match the name on your profile. Update your profile name or use your own card.');
  }
  // The number may arrive masked (xxxxxxxx5647), so only its last four digits are compared.
  const uidLast4 = uid?.match(/(\d{4})$/)?.[1] ?? null;
  summary.uidLast4 = uidLast4;

  // 6. The QR is the only UIDAI-signed part of the card. Every signed QR
  //    found (front and/or back) must agree with what is printed.
  const secureQrs = sides.map((s) => s.qr).filter((q): q is NonNullable<typeof q> => q?.status === 'SECURE');
  summary.qrStatus = secureQrs.length ? 'SECURE' : (sides.map((s) => s.qr?.status).find(Boolean) ?? 'NOT_PRESENT');
  if (secureQrs.length === 0) {
    summary.flags.push('qr-not-signed');
    return reject(QR_HELP);
  }
  for (const qr of secureQrs) {
    if (qr.name && !namesMatch(qr.name, printedName)) {
      summary.flags.push('qr:name-mismatch');
      return reject('The name printed on your card does not match its QR code. Upload a photo of your original card.');
    }
    if (qr.lastFour && uidLast4 && qr.lastFour !== uidLast4) {
      summary.flags.push('qr:number-mismatch');
      return reject('The Aadhaar number on your card does not match its QR code. Upload a photo of your original card.');
    }
  }
  // At least one signed QR must have confirmed the number, or an admin decides.
  if (!uidLast4 || !secureQrs.some((qr) => qr.lastFour)) {
    summary.flags.push('number-not-cross-checked');
    return reject(QR_HELP);
  }

  return { decision: 'verified', summary };
}
