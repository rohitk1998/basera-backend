import type { AadhaarSideResult } from '../payments/cashfree.service';
import { evaluateAadhaar, namesMatch } from './aadhaar-evaluation';

const front = (over: Partial<AadhaarSideResult> = {}): AadhaarSideResult => ({
  side: 'front',
  valid: true,
  referenceId: '101',
  fields: { uid: '123456785647', name: 'Asha Kumari Rao', dob: '1990-01-01' },
  quality: { blur: false, glare: false, partially_present: false, black_and_white: false, face_present: true, face_clear: true, qr_present: true, obscured: false },
  fraud: { is_screenshot: false, is_photo_of_screen: false, is_photo_imposed: false, is_overwritten: false, is_forged: false },
  qr: { status: 'SECURE', name: 'Asha Kumari Rao', lastFour: '5647' },
  ...over,
});
const back = (over: Partial<AadhaarSideResult> = {}): AadhaarSideResult => ({
  side: 'back',
  valid: true,
  referenceId: '102',
  fields: { uid: null, name: null, dob: null },
  quality: { blur: false, glare: false, partially_present: false, black_and_white: false, face_present: null, face_clear: null, qr_present: true, obscured: false },
  fraud: { is_screenshot: false, is_photo_of_screen: false, is_photo_imposed: false, is_overwritten: false, is_forged: false },
  qr: { status: 'SECURE', name: 'Asha Kumari Rao', lastFour: '5647' },
  ...over,
});

const NAME = 'Asha Rao';

describe('namesMatch', () => {
  it.each([
    ['Asha Rao', 'ASHA RAO', true],
    ['Asha  Rao.', 'asha rao', true],
    ['Asha Rao', 'Asha Kumari Rao', true],
    ['A K Rao', 'Asha Kumari Rao', true],
    ['Asha Rao', 'Meera Sharma', false],
    ['Asha Rao', 'Asha Sharma', false],
    ['', 'Asha Rao', false],
  ])('%s vs %s -> %s', (a, b, expected) => expect(namesMatch(a, b)).toBe(expected));
});

describe('evaluateAadhaar', () => {
  it('verifies a clean card with a UIDAI-signed QR and matching names', () => {
    const d = evaluateAadhaar(front(), back(), NAME);
    expect(d.decision).toBe('verified');
    expect(d.summary).toMatchObject({ qrStatus: 'SECURE', uidLast4: '5647', referenceIds: ['101', '102'] });
  });

  it('does not depend on upload order (back first, front second)', () => {
    expect(evaluateAadhaar(back(), front(), NAME).decision).toBe('verified');
  });

  it('keeps no full Aadhaar number, address or photo in the summary', () => {
    const json = JSON.stringify(evaluateAadhaar(front(), back(), NAME).summary);
    expect(json).not.toContain('123456785647');
    expect(json).not.toMatch(/address|photo|hash/i);
  });

  it('copes with a masked number (xxxxxxxx5647)', () => {
    const d = evaluateAadhaar(front({ fields: { uid: 'xxxxxxxx5647', name: 'Asha Kumari Rao', dob: null } }), back(), NAME);
    expect(d.decision).toBe('verified');
  });

  it.each(['is_screenshot', 'is_photo_of_screen', 'is_photo_imposed', 'is_overwritten', 'is_forged'])(
    'rejects when %s is true, even though Cashfree said VALID',
    (flag) => {
      const bad = front({ fraud: { ...front().fraud, [flag]: true } });
      const d = evaluateAadhaar(bad, back(), NAME);
      expect(d.decision).toBe('rejected');
      expect(d.summary.flags[0]).toBe(`fraud:${flag}`);
    },
  );

  it('rejects a fraud flag on the back side too', () => {
    const d = evaluateAadhaar(front(), back({ fraud: { ...back().fraud, is_screenshot: true } }), NAME);
    expect(d.decision).toBe('rejected');
  });

  it.each(['blur', 'glare', 'partially_present', 'obscured'])('rejects a %s photo with a retake message', (flag) => {
    const d = evaluateAadhaar(front({ quality: { ...front().quality, [flag]: true } }), back(), NAME);
    expect(d).toMatchObject({ decision: 'rejected' });
    expect((d as any).reason).toMatch(/Retake/);
  });

  it('rejects when the face on the front is not clear', () => {
    expect(evaluateAadhaar(front({ quality: { ...front().quality, face_clear: false } }), back(), NAME).decision).toBe('rejected');
    expect(evaluateAadhaar(front({ quality: { ...front().quality, face_present: false } }), back(), NAME).decision).toBe('rejected');
  });

  it('treats null flags as "unknown", not as failures', () => {
    const nulls = Object.fromEntries(Object.keys(front().quality).map((k) => [k, null]));
    expect(evaluateAadhaar(front({ quality: nulls }), back(), NAME).decision).toBe('verified');
  });

  it('rejects an unreadable file', () => {
    expect(evaluateAadhaar(front({ valid: false }), back(), NAME).decision).toBe('rejected');
  });

  it('rejects the same side uploaded twice', () => {
    const d = evaluateAadhaar(front(), front({ referenceId: '103' }), NAME);
    expect(d).toMatchObject({ decision: 'rejected' });
    expect((d as any).reason).toMatch(/same side/);
  });

  it('rejects two backs, and an undetected side', () => {
    expect(evaluateAadhaar(back(), back(), NAME).decision).toBe('rejected');
    expect(evaluateAadhaar(front({ side: 'unknown' }), back(), NAME).decision).toBe('rejected');
  });

  it("rejects someone else's card (name differs from the profile)", () => {
    const d = evaluateAadhaar(front({ fields: { uid: '123456785647', name: 'Meera Sharma', dob: null }, qr: { status: 'SECURE', name: 'Meera Sharma', lastFour: '5647' } }), back(), NAME);
    expect(d).toMatchObject({ decision: 'rejected' });
    expect((d as any).reason).toMatch(/profile/);
  });

  it('rejects an edited card: printed name differs from the QR name', () => {
    const d = evaluateAadhaar(front(), back({ qr: { status: 'SECURE', name: 'Meera Sharma', lastFour: '5647' } }), NAME);
    expect(d).toMatchObject({ decision: 'rejected' });
    expect(d.summary.flags).toContain('qr:name-mismatch');
  });

  it('rejects an edited card: printed number differs from the QR number', () => {
    const d = evaluateAadhaar(front(), back({ qr: { status: 'SECURE', name: 'Asha Kumari Rao', lastFour: '9999' } }), NAME);
    expect(d).toMatchObject({ decision: 'rejected' });
    expect(d.summary.flags).toContain('qr:number-mismatch');
  });

  it.each(['PRIMITIVE', 'NOT_PRESENT', 'UNPROCESSABLE'])('rejects a %s QR (nothing can be confirmed) and tells the user what to do', (status) => {
    const d = evaluateAadhaar(front({ qr: { status, name: null, lastFour: null } }), back({ qr: { status, name: null, lastFour: null } }), NAME);
    expect(d).toMatchObject({ decision: 'rejected' });
    expect((d as any).reason).toMatch(/e-Aadhaar/);
    expect(d.summary.qrStatus).toBe(status);
  });

  it('rejects a card with no QR object at all', () => {
    expect(evaluateAadhaar(front({ qr: null }), back({ qr: null }), NAME).decision).toBe('rejected');
  });

  it('rejects when the name cannot be read from the front, asking for a retake', () => {
    const d = evaluateAadhaar(front({ fields: { uid: '123456785647', name: null, dob: null } }), back(), NAME);
    expect(d).toMatchObject({ decision: 'rejected' });
    expect((d as any).reason).toMatch(/Retake/);
  });

  it('rejects when the number cannot be cross-checked with the QR', () => {
    expect(evaluateAadhaar(front({ fields: { uid: null, name: 'Asha Kumari Rao', dob: null } }), back(), NAME).decision).toBe('rejected');
    const noDigits = { status: 'SECURE', name: 'Asha Kumari Rao', lastFour: null };
    expect(evaluateAadhaar(front({ qr: noDigits }), back({ qr: noDigits }), NAME).decision).toBe('rejected');
  });

  it('accepts a SECURE QR found on only one side', () => {
    const d = evaluateAadhaar(front({ qr: { status: 'NOT_PRESENT', name: null, lastFour: null } }), back(), NAME);
    expect(d.decision).toBe('verified');
  });
});

describe('there is no manual-review outcome', () => {
  it('only ever verifies or rejects', () => {
    const outcomes = new Set<string>();
    const qrStates = ['SECURE', 'PRIMITIVE', 'NOT_PRESENT', 'UNPROCESSABLE'];
    for (const status of qrStates) {
      for (const lastFour of ['5647', null]) {
        outcomes.add(evaluateAadhaar(front({ qr: { status, name: 'Asha Kumari Rao', lastFour } }), back({ qr: { status, name: 'Asha Kumari Rao', lastFour } }), NAME).decision);
      }
    }
    expect([...outcomes].sort()).toEqual(['rejected', 'verified']);
  });
});
