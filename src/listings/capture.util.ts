import { isInsideHimachal } from './hp-locations';
import {
  distanceMetres,
  formatDistance,
  isUsableGps,
  WALKTHROUGH_GPS_TOLERANCE_METRES,
} from './walkthrough-gps.util';

export const CAPTURE_MAX_ACCURACY_METRES = 100;

export const CAPTURE_MAX_AGE_MS: Record<CaptureKind, number> = {
  photo: 5 * 60 * 1000,
  video: 15 * 60 * 1000,

  wifi: 5 * 60 * 1000,
};

export const CAPTURE_FUTURE_SKEW_MS = 60 * 1000;

export type CaptureKind = 'photo' | 'video' | 'wifi';

export type CaptureClaim = {
  lat: number;
  lng: number;
  accuracyM: number;
  capturedAtMs: number;
};

export type CaptureRecord = {
  kind: CaptureKind;
  lat: number;
  lng: number;
  accuracyM: number;

  capturedAt: string;

  receivedAt: string;

  distanceFromPinM: number;

  source: 'device_reported';

  bypassed?: true;
};

export type CaptureAssessment = { ok: true; record: CaptureRecord } | { ok: false; reason: string };

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseCaptureClaim(raw: unknown): { ok: true; claim: CaptureClaim } | { ok: false; reason: string } {
  const missing = {
    ok: false as const,
    reason: 'This file has no camera capture details. Take it with the in-app camera, with location access allowed.',
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return missing;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
  const lat = num(o.lat);
  const lng = num(o.lng);
  const accuracy = num(o.accuracy);
  const capturedAtMs = typeof o.capturedAt === 'string' || typeof o.capturedAt === 'number' ? new Date(o.capturedAt).getTime() : NaN;

  if (!isNumber(lat) || !isNumber(lng) || !isNumber(accuracy) || !Number.isFinite(capturedAtMs)) {
    return {
      ok: false,
      reason: 'The capture location or time is missing or invalid. Allow location access and capture it again.',
    };
  }
  return { ok: true, claim: { lat, lng, accuracyM: accuracy, capturedAtMs } };
}

export function assessCapture(
  claim: CaptureClaim,
  pin: { lat: number; lng: number },
  kind: CaptureKind,
  now = Date.now(),
): CaptureAssessment {
  if (!isUsableGps(claim.lat, claim.lng) || !isInsideHimachal(claim.lat, claim.lng)) {
    return {
      ok: false,
      reason: 'The location reported by your device is outside Himachal Pradesh, so this cannot be accepted for a listing here.',
    };
  }
  if (!(claim.accuracyM > 0) || claim.accuracyM > CAPTURE_MAX_ACCURACY_METRES) {
    return {
      ok: false,
      reason: `Your device located you only to within ${formatAccuracy(claim.accuracyM)}; we need ${CAPTURE_MAX_ACCURACY_METRES} m or better. Step outside or next to a window, wait for the location to settle, and capture again.`,
    };
  }

  const age = now - claim.capturedAtMs;
  if (age < -CAPTURE_FUTURE_SKEW_MS) {
    return {
      ok: false,
      reason: 'Your device clock is ahead of the correct time. Set the date and time to automatic and capture again.',
    };
  }
  if (age > CAPTURE_MAX_AGE_MS[kind]) {
    const minutes = Math.round(CAPTURE_MAX_AGE_MS[kind] / 60000);
    return {
      ok: false,
      reason: `This capture is more than ${minutes} minutes old by the time it reached us (or your device clock is behind). Capture it again.`,
    };
  }

  const distance = distanceMetres(pin, { lat: claim.lat, lng: claim.lng });
  if (distance > WALKTHROUGH_GPS_TOLERANCE_METRES) {
    return {
      ok: false,
      reason: `This was captured ${formatDistance(distance)} from the pin you dropped (the limit is ${WALKTHROUGH_GPS_TOLERANCE_METRES} m). Capture it at the property, or move the pin onto the property.`,
    };
  }

  return {
    ok: true,
    record: {
      kind,
      lat: claim.lat,
      lng: claim.lng,
      accuracyM: Math.round(claim.accuracyM * 10) / 10,
      capturedAt: new Date(claim.capturedAtMs).toISOString(),
      receivedAt: new Date(now).toISOString(),
      distanceFromPinM: Math.round(distance),
      source: 'device_reported',
    },
  };
}

function formatAccuracy(m: number): string {
  return Number.isFinite(m) && m > 0 ? `${Math.round(m)} m` : 'an unknown distance';
}

export function isCaptureRecord(v: unknown): v is CaptureRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    isNumber(r.lat) &&
    isNumber(r.lng) &&
    isNumber(r.accuracyM) &&
    isNumber(r.distanceFromPinM) &&
    typeof r.capturedAt === 'string' &&
    r.source === 'device_reported'
  );
}

export function withDistanceFrom(record: CaptureRecord, pin: { lat: number; lng: number }): CaptureRecord {
  if (record.bypassed === true) return record;
  return { ...record, distanceFromPinM: Math.round(distanceMetres(pin, record)) };
}

export function isWithinTolerance(record: CaptureRecord): boolean {
  return record.bypassed === true || record.distanceFromPinM <= WALKTHROUGH_GPS_TOLERANCE_METRES;
}

export const BYPASS_FALLBACK_POINT = { lat: 31.1048, lng: 77.1734 };

export function bypassedCaptureRecord(
  kind: CaptureKind,
  pin: { lat: number; lng: number } | undefined,
  rawClaim?: unknown,
  now = Date.now(),
): CaptureRecord {
  let at = pin;
  if (!at) {
    const parsed = parseCaptureClaim(rawClaim);
    at =
      parsed.ok && isUsableGps(parsed.claim.lat, parsed.claim.lng)
        ? { lat: parsed.claim.lat, lng: parsed.claim.lng }
        : BYPASS_FALLBACK_POINT;
  }
  const iso = new Date(now).toISOString();
  return {
    kind,
    lat: at.lat,
    lng: at.lng,
    accuracyM: 1,
    capturedAt: iso,
    receivedAt: iso,
    distanceFromPinM: 0,
    source: 'device_reported',
    bypassed: true,
  };
}
