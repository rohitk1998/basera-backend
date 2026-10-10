import { assessCapture, parseCaptureClaim, withDistanceFrom, isWithinTolerance, CAPTURE_MAX_ACCURACY_METRES } from './capture.util';

const PIN = { lat: 32.219, lng: 76.3234 }; // Dharamshala
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const claim = (over: Record<string, unknown> = {}) => ({
  lat: PIN.lat,
  lng: PIN.lng,
  accuracyM: 15,
  capturedAtMs: NOW - 10_000,
  ...over,
});

describe('parseCaptureClaim', () => {
  it('reads numbers and numeric strings (multipart sends strings)', () => {
    const r = parseCaptureClaim({ lat: '32.219', lng: 76.3234, accuracy: '12.5', capturedAt: '2026-09-30T11:59:50.000Z' });
    expect(r).toEqual({ ok: true, claim: { lat: 32.219, lng: 76.3234, accuracyM: 12.5, capturedAtMs: Date.UTC(2026, 8, 30, 11, 59, 50) } });
  });

  it.each([undefined, null, 'x', [], {}, { lat: 1, lng: 2 }, { lat: '', lng: 2, accuracy: 3, capturedAt: 1 }, { lat: 1, lng: 2, accuracy: 3, capturedAt: 'nope' }])(
    'refuses a missing or malformed claim: %j',
    (raw) => {
      expect(parseCaptureClaim(raw).ok).toBe(false);
    },
  );
});

describe('assessCapture', () => {
  it('accepts a fresh, accurate capture at the pin and records it as device-reported', () => {
    const r = assessCapture(claim(), PIN, 'photo', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record).toMatchObject({ kind: 'photo', source: 'device_reported', distanceFromPinM: 0, accuracyM: 15 });
      expect(r.record.receivedAt).toBe(new Date(NOW).toISOString());
    }
  });

  it('refuses coordinates outside Himachal Pradesh, 0,0 and out-of-range values', () => {
    for (const bad of [{ lat: 28.61, lng: 77.2 }, { lat: 0, lng: 0 }, { lat: 95, lng: 76 }, { lat: 32.2, lng: 200 }]) {
      const r = assessCapture(claim(bad), PIN, 'photo', NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/outside Himachal Pradesh/);
    }
  });

  it('refuses an accuracy worse than the limit, or no accuracy at all', () => {
    expect(assessCapture(claim({ accuracyM: CAPTURE_MAX_ACCURACY_METRES }), PIN, 'photo', NOW).ok).toBe(true);
    const r = assessCapture(claim({ accuracyM: CAPTURE_MAX_ACCURACY_METRES + 1 }), PIN, 'photo', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/only to within 101 m/);
    expect(assessCapture(claim({ accuracyM: 0 }), PIN, 'photo', NOW).ok).toBe(false);
    expect(assessCapture(claim({ accuracyM: -5 }), PIN, 'photo', NOW).ok).toBe(false);
  });

  it('refuses a capture time in the future, but allows a little clock skew', () => {
    const future = assessCapture(claim({ capturedAtMs: NOW + 5 * 60_000 }), PIN, 'photo', NOW);
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.reason).toMatch(/clock is ahead/);
    expect(assessCapture(claim({ capturedAtMs: NOW + 30_000 }), PIN, 'photo', NOW).ok).toBe(true);
  });

  it('refuses a stale photo (5 min) sooner than a stale video (15 min)', () => {
    const eightMinutesOld = claim({ capturedAtMs: NOW - 8 * 60_000 });
    expect(assessCapture(eightMinutesOld, PIN, 'photo', NOW).ok).toBe(false);
    expect(assessCapture(eightMinutesOld, PIN, 'video', NOW).ok).toBe(true);
    expect(assessCapture(claim({ capturedAtMs: NOW - 20 * 60_000 }), PIN, 'video', NOW).ok).toBe(false);
  });

  it('refuses a capture more than 200 m from the pin, and names the distance', () => {
    const near = assessCapture(claim({ lat: PIN.lat + 0.0015 }), PIN, 'photo', NOW); // ~167 m
    expect(near.ok).toBe(true);
    const far = assessCapture(claim({ lat: PIN.lat + 0.003 }), PIN, 'photo', NOW); // ~333 m
    expect(far.ok).toBe(false);
    if (!far.ok) expect(far.reason).toMatch(/captured \d+m from the pin/);
  });
});

describe('withDistanceFrom', () => {
  it('re-measures a stored capture against a moved pin', () => {
    const r = assessCapture(claim(), PIN, 'photo', NOW);
    if (!r.ok) throw new Error('setup');
    const moved = withDistanceFrom(r.record, { lat: PIN.lat + 0.01, lng: PIN.lng });
    expect(moved.distanceFromPinM).toBeGreaterThan(1000);
    expect(isWithinTolerance(moved)).toBe(false);
    expect(isWithinTolerance(r.record)).toBe(true);
  });
});
