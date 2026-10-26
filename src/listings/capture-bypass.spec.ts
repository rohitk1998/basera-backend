import { createHash } from 'crypto';
import { validateEnv } from '../config/env.validation';
import { evaluateCaptureEvidence } from './capture-evidence.util';
import { BYPASS_FALLBACK_POINT, bypassedCaptureRecord, isCaptureRecord, isWithinTolerance, withDistanceFrom } from './capture.util';
import { isInsideHimachal } from './hp-locations';
import { approvalBlockers } from '../admin/admin.service';
import { HostListingsService } from './host-listings.service';

const PIN = { lat: 32.219, lng: 76.3234 };
const FAR_PIN = { lat: 31.1, lng: 77.17 };

describe('bypassedCaptureRecord', () => {
  it('uses the pin when there is one', () => {
    const r = bypassedCaptureRecord('photo', PIN, { lat: 30, lng: 70 });
    expect(r).toMatchObject({ ...PIN, accuracyM: 1, distanceFromPinM: 0, bypassed: true, source: 'device_reported' });
    expect(isCaptureRecord(r)).toBe(true);
  });
  it('uses a usable claimed position without a pin, else the Himachal fallback', () => {
    expect(bypassedCaptureRecord('photo', undefined, { lat: 31.5, lng: 77, accuracy: 5, capturedAt: Date.now() })).toMatchObject({ lat: 31.5, lng: 77 });
    expect(bypassedCaptureRecord('photo', undefined, null)).toMatchObject(BYPASS_FALLBACK_POINT);
    expect(isInsideHimachal(BYPASS_FALLBACK_POINT.lat, BYPASS_FALLBACK_POINT.lng)).toBe(true);
  });
  it('is never too far, even against a moved pin', () => {
    const r = withDistanceFrom(bypassedCaptureRecord('photo', PIN), FAR_PIN);
    expect(r.distanceFromPinM).toBe(0);
    expect(isWithinTolerance(r)).toBe(true);
  });
});

describe('capture evidence with bypassed records', () => {
  it('reports state captured and bypassed, even with the pin moved far away', () => {
    const photo = bypassedCaptureRecord('photo', PIN);
    const video = bypassedCaptureRecord('video', PIN);
    const ev = evaluateCaptureEvidence({
      property_details: { ...FAR_PIN, photos: [{ url: 'u1', room: 'living' }] },
      telemetry: {
        walkthroughPassed: true,
        walkthroughCheck: { method: 'unanalysed', bypassed: true, capture: video, warnings: [] },
      },
      captures: { photos: { u1: photo } },
    });
    expect(ev.walkthrough).toMatchObject({ state: 'captured', bypassed: true });
    expect(ev.photos[0]).toMatchObject({ state: 'captured', bypassed: true });
    expect(ev.problems.join()).not.toMatch(/too far|no capture data/);
  });

  it('never reads as passed: the camera-capture layer is submitted and blocks approval', () => {
    const ev = evaluateCaptureEvidence({
      property_details: { ...PIN, photos: [{ url: 'u1', room: 'living' }] },
      telemetry: {
        walkthroughPassed: true,
        walkthroughCheck: { method: 'camera_captured', bypassed: true, capture: bypassedCaptureRecord('video', PIN), warnings: [] },
      },
      captures: { photos: { u1: bypassedCaptureRecord('photo', PIN) } },
    });
    expect(ev.status).toBe('submitted');
    expect(ev.problems.join()).toMatch(/bypassed \(test mode\).*audited override/);
    const blockers = approvalBlockers({ telemetry: ev.status, telemetryProblems: ev.problems });
    expect(blockers.join()).toMatch(/Camera capture is submitted.*bypassed/);
  });

  it('a single bypassed photo is enough to block, even when the walkthrough is a real capture', () => {
    const real = { ...bypassedCaptureRecord('video', PIN), bypassed: undefined, distanceFromPinM: 10 };
    delete (real as any).bypassed;
    const ev = evaluateCaptureEvidence({
      property_details: { ...PIN, photos: [{ url: 'u1' }, { url: 'u2' }] },
      telemetry: { walkthroughPassed: true, walkthroughCheck: { method: 'camera_captured', capture: real, warnings: [] } },
      captures: { photos: { u1: { ...real, kind: 'photo' }, u2: bypassedCaptureRecord('photo', PIN) } },
    });
    expect(ev.status).toBe('submitted');
  });

  it('with no bypassed capture the verdict is unchanged (passed)', () => {
    const real = { ...bypassedCaptureRecord('video', PIN), distanceFromPinM: 10 };
    delete (real as any).bypassed;
    const ev = evaluateCaptureEvidence({
      property_details: { ...PIN, photos: [{ url: 'u1' }] },
      telemetry: { walkthroughPassed: true, walkthroughCheck: { method: 'camera_captured', capture: real, warnings: [] } },
      captures: { photos: { u1: { ...real, kind: 'photo' } } },
    });
    expect(ev.status).toBe('passed');
    expect(ev.problems).toEqual([]);
  });
});

describe('submit-time sites with the flag', () => {
  const build = (bypass: boolean, redis: Map<string, string>) =>
    new HostListingsService(
      {} as any, {} as any, {} as any,
      { get: async (k: string) => redis.get(k) ?? null, set: async () => true, del: async () => {} } as any,
      {} as any, {} as any, { locationBypass: bypass } as any,
    );
  const receiptFor = (url: string) => `capture-receipt:u1:${createHash('sha256').update(url).digest('hex')}`;

  it.each([true, false])('photo captured at the old pin, new pin 100+ km away (bypass=%s)', async (bypass) => {
    const redis = new Map([[receiptFor('p1'), JSON.stringify(bypassedCaptureRecord('photo', PIN))]]);
    const svc = build(bypass, redis);
    const call = (svc as any).resolvePhotoCaptures('u1', [{ url: 'p1' }], null, FAR_PIN);

    await expect(call).resolves.toMatchObject({ captures: { p1: { bypassed: true } } });
    await svc.onModuleDestroy();
  });

  it('a REAL record that is too far still rejects with the flag off, and passes with it on', async () => {
    const real = { ...bypassedCaptureRecord('photo', PIN), bypassed: undefined, distanceFromPinM: 0 };
    delete (real as any).bypassed;
    const redis = new Map([[receiptFor('p1'), JSON.stringify(real)]]);
    const off = build(false, redis);
    await expect((off as any).resolvePhotoCaptures('u1', [{ url: 'p1' }], null, FAR_PIN)).rejects.toThrow(/captured more than/);
    const on = build(true, redis);
    await expect((on as any).resolvePhotoCaptures('u1', [{ url: 'p1' }], null, FAR_PIN)).resolves.toBeDefined();
    await off.onModuleDestroy();
    await on.onModuleDestroy();
  });

  it('walkthrough token: pin moved far is rejected with the flag off and accepted with it on', async () => {
    const check = { method: 'camera_captured', visuallyVerified: false, capture: { ...bypassedCaptureRecord('video', PIN), bypassed: undefined }, warnings: [], checkedAt: 'x' };
    delete (check.capture as any).bypassed;
    const redis = new Map([['walkthrough-token:u1:t', JSON.stringify({ ...PIN, check })]]);
    const off = build(false, redis);
    await expect((off as any).readWalkthroughToken('u1', 't', FAR_PIN, false)).rejects.toThrow(/pin has moved/);
    const on = build(true, redis);
    await expect((on as any).readWalkthroughToken('u1', 't', FAR_PIN, false)).resolves.toMatchObject({ check: { method: 'camera_captured' } });
    await off.onModuleDestroy();
    await on.onModuleDestroy();
  });
});

describe('CAPTURE_LOCATION_BYPASS env validation', () => {
  const base = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
    SUPABASE_JWT_SECRET: 's',
    SUPABASE_DB_HOST: 'h',
    SUPABASE_DB_PASSWORD: 'p',
    FIREBASE_PROJECT_ID: 'f',
    FIREBASE_CLIENT_EMAIL: 'e',
    FIREBASE_PRIVATE_KEY: 'k',
  };
  it('defaults to false and parses true/false/1/0', () => {
    expect(validateEnv({ ...base }).CAPTURE_LOCATION_BYPASS).toBe(false);
    expect(validateEnv({ ...base, CAPTURE_LOCATION_BYPASS: 'false' }).CAPTURE_LOCATION_BYPASS).toBe(false);
    expect(validateEnv({ ...base, CAPTURE_LOCATION_BYPASS: '0' }).CAPTURE_LOCATION_BYPASS).toBe(false);
    expect(validateEnv({ ...base, CAPTURE_LOCATION_BYPASS: '' }).CAPTURE_LOCATION_BYPASS).toBe(false);
    expect(validateEnv({ ...base, CAPTURE_LOCATION_BYPASS: 'true', NODE_ENV: 'development' }).CAPTURE_LOCATION_BYPASS).toBe(true);
    expect(validateEnv({ ...base, CAPTURE_LOCATION_BYPASS: '1' }).CAPTURE_LOCATION_BYPASS).toBe(true);
  });
  it('rejects garbage', () => {
    expect(() => validateEnv({ ...base, CAPTURE_LOCATION_BYPASS: 'yes please' })).toThrow();
  });
  it('refuses to boot when enabled in production', () => {
    expect(() => validateEnv({ ...base, CAPTURE_LOCATION_BYPASS: 'true', NODE_ENV: 'production' })).toThrow(
      'CAPTURE_LOCATION_BYPASS must never be enabled in production',
    );
    expect(validateEnv({ ...base, CAPTURE_LOCATION_BYPASS: 'false', NODE_ENV: 'production' }).CAPTURE_LOCATION_BYPASS).toBe(false);
  });
});
