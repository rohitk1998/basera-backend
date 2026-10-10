import { approvalBlockers } from './admin.service';
import { evaluateCaptureEvidence } from '../listings/capture-evidence.util';

describe('approvalBlockers', () => {
  it('is empty when camera capture and banking have passed — no field visit is asked for', () => {
    expect(approvalBlockers({ telemetry: 'passed', banking: 'passed' })).toEqual([]);
  });

  it('ignores a field-visit status entirely, passed or not', () => {
    // Extra properties at runtime (an old caller still passing `visit`) must not matter.
    const layers = { telemetry: 'passed', banking: 'passed', visit: 'not_started' } as { telemetry: string; banking: string };
    expect(approvalBlockers(layers)).toEqual([]);
  });

  it('names every unmet check, treating not_started as unmet', () => {
    expect(approvalBlockers({ telemetry: 'not_started', banking: 'not_started' })).toEqual([
      'Camera capture is not started',
      'Banking is not started',
    ]);
  });

  it('does not accept a submitted or failed check as passed', () => {
    expect(approvalBlockers({ telemetry: 'submitted', banking: 'failed' })).toEqual([
      'Camera capture is submitted',
      'Banking is failed',
    ]);
  });

  it('says why camera capture is not passed', () => {
    expect(
      approvalBlockers({
        telemetry: 'submitted',
        banking: 'passed',
        telemetryProblems: ['2 photos uploaded before camera capture (no capture data)'],
      }),
    ).toEqual(['Camera capture is submitted (2 photos uploaded before camera capture (no capture data))']);
  });
});

describe('camera capture as the approval requirement', () => {
  const PIN = { lat: 32.219, lng: 76.3234 };
  const capture = (over: Record<string, unknown> = {}) => ({
    kind: 'photo',
    lat: PIN.lat,
    lng: PIN.lng,
    accuracyM: 12,
    capturedAt: '2026-09-30T10:00:00.000Z',
    receivedAt: '2026-09-30T10:00:05.000Z',
    distanceFromPinM: 0,
    source: 'device_reported',
    ...over,
  });
  const photos = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `https://s/p${i}.jpg`, room: 'living' }));
  const capturedPhotos = (n: number, over: Record<string, unknown> = {}) =>
    Object.fromEntries(photos(n).map((p) => [p.url, capture(over)]));
  const draft = (over: Record<string, any> = {}) => ({
    property_details: { ...PIN, photos: photos(5) },
    telemetry: {
      walkthroughPassed: true,
      walkthroughVideoUrl: 'https://s/w.webm',
      walkthroughCheck: { method: 'camera_captured', capture: capture({ kind: 'video' }), warnings: [] },
    },
    captures: { photos: capturedPhotos(5) },
    ...over,
  });

  it('passes a listing whose walkthrough and every photo were captured near the pin', () => {
    const e = evaluateCaptureEvidence(draft());
    expect(e.status).toBe('passed');
    expect(e.problems).toEqual([]);
    expect(e.deviceReported).toBe(true);
    expect(e.photos.every((p) => p.state === 'captured')).toBe(true);
  });

  it('is not started with no walkthrough', () => {
    const e = evaluateCaptureEvidence(draft({ telemetry: {} }));
    expect(e.status).toBe('not_started');
    expect(e.problems).toContain('no walkthrough video');
  });

  it('treats media from before camera capture as having no capture data, never as passed', () => {
    const e = evaluateCaptureEvidence({
      property_details: { ...PIN, photos: photos(5) },
      telemetry: { walkthroughPassed: true, walkthroughToken: 'x', walkthroughCheck: { method: 'gps_tag_only', gpsTagWithinRadius: true } },
    });
    expect(e.status).toBe('submitted');
    expect(e.walkthrough.state).toBe('legacy');
    expect(e.photos.every((p) => p.state === 'legacy' && p.capture === undefined)).toBe(true);
    expect(e.problems.join(' ')).toMatch(/5 photos uploaded before camera capture/);
  });

  it('keeps a mixed listing out of passed and says how many photos have no capture data', () => {
    const captured = capturedPhotos(5);
    delete captured['https://s/p0.jpg'];
    const e = evaluateCaptureEvidence(draft({ captures: { photos: captured } }));
    expect(e.status).toBe('submitted');
    expect(e.photos.filter((p) => p.state === 'legacy')).toHaveLength(1);
    expect(e.problems).toEqual(['1 photo uploaded before camera capture (no capture data)']);
  });

  it('re-measures captures against the pin on the listing, so a stale stored distance cannot pass', () => {
    const e = evaluateCaptureEvidence(
      draft({ captures: { photos: capturedPhotos(5, { lat: 32.3, lng: 76.4, distanceFromPinM: 0 }) } }),
    );
    expect(e.status).toBe('submitted');
    expect(e.photos.every((p) => p.state === 'out_of_range')).toBe(true);
    expect(e.photos[0].capture!.distanceFromPinM).toBeGreaterThan(1000);
    expect(e.problems.join(' ')).toMatch(/5 photos captured too far from the pin/);
  });

  it('flags a walkthrough captured away from the pin', () => {
    const d = draft();
    d.telemetry.walkthroughCheck.capture = capture({ kind: 'video', lat: 32.3, lng: 76.4 });
    const e = evaluateCaptureEvidence(d);
    expect(e.walkthrough.state).toBe('out_of_range');
    expect(e.status).toBe('submitted');
  });

  it('accepts an unanalysed walkthrough that still carries a capture, and says so', () => {
    const d = draft();
    d.telemetry.walkthroughCheck.method = 'unanalysed';
    const e = evaluateCaptureEvidence(d);
    expect(e.walkthrough.state).toBe('unanalysed');
    expect(e.status).toBe('passed');
  });
});
