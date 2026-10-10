import { isInsideHimachal } from './hp-locations';
import {
  distanceMetres,
  formatDistance,
  isUsableGps,
  WALKTHROUGH_GPS_TOLERANCE_METRES,
} from './walkthrough-gps.util';

/*
 * In-app camera capture evidence.
 *
 * Listing photos and the walkthrough video can only be supplied by capturing
 * them with the camera inside the app. At the moment of capture the browser
 * reads the device's location and sends it with the file. Everything in this
 * module is a plausibility check on those numbers, and every number is
 * DEVICE-REPORTED: the client says where it was. A modified client (or a
 * mock-location app on the phone) can claim any position, so nothing here
 * proves a host stood at the property and nothing may be described as
 * "verified by Basera". It raises the cost of faking a listing from "upload
 * stock photos" to "defeat the camera and the location API", and gives the
 * reviewer a map to look at.
 */

/** A fix worse than this is a guess (cell tower / IP), not a position. The
 *  client refuses to capture above it; the server holds the same line. */
export const CAPTURE_MAX_ACCURACY_METRES = 100;

/** How stale a capture may be when the server receives it. A photo is sent the
 *  moment it is taken, so this is short; a walkthrough is a large file on a
 *  mobile connection, so its clock includes the upload. */
export const CAPTURE_MAX_AGE_MS: Record<CaptureKind, number> = {
  photo: 5 * 60 * 1000,
  video: 15 * 60 * 1000,
};

/** How far ahead of the server clock a capture timestamp may be before it is a
 *  wrong clock rather than ordinary skew. */
export const CAPTURE_FUTURE_SKEW_MS = 60 * 1000;

export type CaptureKind = 'photo' | 'video';

/** What the client sent with a file. */
export type CaptureClaim = {
  lat: number;
  lng: number;
  accuracyM: number;
  capturedAtMs: number;
};

/** What is stored with the listing for the reviewer. */
export type CaptureRecord = {
  kind: CaptureKind;
  lat: number;
  lng: number;
  accuracyM: number;
  /** When the device says it captured the file (ISO). */
  capturedAt: string;
  /** When the server received it (ISO). */
  receivedAt: string;
  /** Distance from the listing pin, metres. Recomputed against the final pin at submit. */
  distanceFromPinM: number;
  /** Always `device_reported`: see the note at the top of this file. */
  source: 'device_reported';
  /** TEST ONLY: set when CAPTURE_LOCATION_BYPASS was on. The location checks
   *  were skipped, so lat/lng/accuracy here are NOT a device reading. */
  bypassed?: true;
};

export type CaptureAssessment = { ok: true; record: CaptureRecord } | { ok: false; reason: string };

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Reads the loosely-typed object the client sent. Numbers may arrive as strings from multipart. */
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

/**
 * Checks one capture claim against the listing pin. Order matters only for the
 * message the host sees: the most fixable problem is reported first.
 */
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

/** True when a stored record is shaped like one this module wrote. Stored JSON
 *  is read back in several places, so it is checked before it is trusted. */
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

/** Re-measures a stored capture against the pin as it stands now. */
export function withDistanceFrom(record: CaptureRecord, pin: { lat: number; lng: number }): CaptureRecord {
  if (record.bypassed === true) return record;
  return { ...record, distanceFromPinM: Math.round(distanceMetres(pin, record)) };
}

export function isWithinTolerance(record: CaptureRecord): boolean {
  return record.bypassed === true || record.distanceFromPinM <= WALKTHROUGH_GPS_TOLERANCE_METRES;
}

/** Used only when CAPTURE_LOCATION_BYPASS is on (test use). Used when there is
 *  no pin and no usable claimed position: Shimla. */
export const BYPASS_FALLBACK_POINT = { lat: 31.1048, lng: 77.1734 };

/** Builds the record stored for a capture whose location checks were skipped:
 *  at the pin, else at the claimed position if usable, else the fallback point. */
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
