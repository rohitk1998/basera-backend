import type { CaptureRecord } from './capture.util';

/** Great-circle distance between two lat/lng points, in metres. Standard
 *  haversine formula — accurate enough at the scale we care about (tens to
 *  low hundreds of metres), no need for a geodesy library. */
export function distanceMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** How far a capture's device-reported location may sit from the host's
 *  pinned location and still count as "the same property." Wide enough to
 *  absorb ordinary phone-GPS drift and someone standing just outside the
 *  building, tight enough that a capture made at a different address fails.
 *  Used for the walkthrough video and for every listing photo. */
export const WALKTHROUGH_GPS_TOLERANCE_METRES = 200;

/** Minimum length a walkthrough video must run, in seconds — matches the
 *  "at least 15 seconds" rule stated in the form and in "Why we ask." A
 *  clip shorter than this cannot possibly cover the required shots (main
 *  room, outlook, speed test). */
export const WALKTHROUGH_MIN_DURATION_SECONDS = 15;

/** Renders a metre distance the way a host should read it: metres below
 *  1km (where the precision is meaningful), kilometres to one decimal
 *  place above that (where metre-level precision is just noise). */
export function formatDistance(metres: number): string {
  if (metres >= 1000) {
    return `${(metres / 1000).toFixed(1)} km`;
  }
  return `${Math.round(metres)}m`;
}

/** A recording timestamp this far ahead of the server clock is not clock
 *  skew, it is a wrong or forged date. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** A walkthrough is meant to be filmed now, on the property. A file recorded
 *  longer ago than this is passed on for review with a note, not refused —
 *  a host may film a few days ahead of listing. */
const STALE_AFTER_DAYS = 30;

/** A "15-second walkthrough" that runs longer than this is not one. */
const IMPLAUSIBLY_LONG_SECONDS = 20 * 60;

/** Editing / generating tools that leave their name in the container. A file
 *  straight off a phone camera does not carry these; a stock clip, a screen
 *  recording or a generated test pattern usually does. */
const EDITOR_PATTERN = /lavf|ffmpeg|handbrake|premiere|capcut|final cut|davinci|imovie|kdenlive|shotcut|\bobs\b|screenrecord/i;

/** The subset of ExifTool's output the sanity checks read. Everything is
 *  optional and loosely typed because containers differ in what they carry. */
export type WalkthroughTags = {
  ImageWidth?: unknown;
  ImageHeight?: unknown;
  SourceImageWidth?: unknown;
  SourceImageHeight?: unknown;
  VideoFrameRate?: unknown;
  CreateDate?: unknown;
  MediaCreateDate?: unknown;
  TrackCreateDate?: unknown;
  CreationDate?: unknown;
  GPSDateTime?: unknown;
  Make?: unknown;
  Model?: unknown;
  Software?: unknown;
  Encoder?: unknown;
  HandlerDescription?: unknown;
};

/** ExifTool hands dates back as rich objects, plain strings, or the literal
 *  "0000:00:00 00:00:00" that a container writes when it has no date. Anything
 *  that does not resolve to a real moment after 1980 is "no timestamp". */
function tagTimeMs(value: unknown): number | undefined {
  let ms: number | undefined;
  if (value && typeof value === 'object') {
    const v = value as { toMillis?: () => number; toDate?: () => Date };
    if (typeof v.toMillis === 'function') ms = v.toMillis();
    else if (typeof v.toDate === 'function') ms = v.toDate().getTime();
  } else if (typeof value === 'string') {
    // "2026:09:29 10:00:00" has no zone; QuickTime dates are UTC, so read it as UTC
    // rather than in whatever zone the server happens to run in.
    const iso = value.trim().replace(/^(\d{4}):(\d{2}):(\d{2})[ T]/, '$1-$2-$3T');
    ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
  } else if (typeof value === 'number') {
    ms = value;
  }
  return typeof ms === 'number' && Number.isFinite(ms) && ms > Date.UTC(1980, 0, 1) ? ms : undefined;
}

const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** A GPS tag of exactly 0,0 is what a camera writes with no fix; it is not a
 *  location, and the pin can never legitimately be there. */
export function isUsableGps(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

export type WalkthroughAssessment = {
  /** Set when the file cannot be accepted at all. */
  failure?: string;
  /** Things that do not fail the file but that a person reviewing the
   *  footage should know about. */
  warnings: string[];
  /** ISO time the file says it was recorded, when it says so. */
  recordedAt?: string;
};

/**
 * Cheap sanity checks on a walkthrough file's own metadata. They catch a file
 * that is not a video at all, a future-dated one, and mark the tell-tale
 * signs of stock, edited or generated footage. They do NOT prove the footage
 * shows the property: every value here is written by whatever made the file
 * and can be edited. Only a person watching the video can do that.
 *
 * `capturedInApp`: the file came out of the browser's MediaRecorder, which
 * writes no recording date and no camera make/model, and whose capture time is
 * checked separately against the server clock (capture.util.ts). So those
 * three observations (no date, stale date, no camera name) are not made for it
 * — they would fire on every genuine recording. The "has a video picture",
 * "made by editing software" and "implausibly long" checks still apply.
 */
export function assessWalkthroughMetadata(
  tags: WalkthroughTags,
  durationSeconds: number,
  now = Date.now(),
  opts: { capturedInApp?: boolean } = {},
): WalkthroughAssessment {
  const warnings: string[] = [];

  const hasVideoTrack =
    (positive(tags.ImageWidth) && positive(tags.ImageHeight)) ||
    (positive(tags.SourceImageWidth) && positive(tags.SourceImageHeight)) ||
    positive(tags.VideoFrameRate) ||
    (typeof tags.VideoFrameRate === 'string' && parseFloat(tags.VideoFrameRate) > 0);
  if (!hasVideoTrack) {
    return {
      failure: 'This file has no video picture in it. Record the walkthrough with your camera app and upload that file.',
      warnings,
    };
  }

  const recorded = [tags.CreationDate, tags.CreateDate, tags.MediaCreateDate, tags.TrackCreateDate, tags.GPSDateTime]
    .map(tagTimeMs)
    .find((ms) => ms !== undefined);
  if (recorded === undefined) {
    if (!opts.capturedInApp) warnings.push('The file carries no recording date.');
  } else if (recorded > now + FUTURE_TOLERANCE_MS) {
    return {
      failure: 'This video says it was recorded in the future. Check your phone\'s date and re-record the walkthrough.',
      warnings,
    };
  } else {
    const ageDays = (now - recorded) / (24 * 60 * 60 * 1000);
    if (ageDays > STALE_AFTER_DAYS && !opts.capturedInApp) {
      warnings.push(`The file says it was recorded ${Math.round(ageDays)} days ago.`);
    }
  }

  const gpsTime = tagTimeMs(tags.GPSDateTime);
  if (recorded !== undefined && gpsTime !== undefined && Math.abs(gpsTime - recorded) > FUTURE_TOLERANCE_MS) {
    warnings.push('The location time and the recording date in the file are more than a day apart.');
  }

  const toolText = [tags.Software, tags.Encoder, tags.HandlerDescription].map(text).join(' ');
  const editor = EDITOR_PATTERN.exec(toolText);
  if (editor) {
    warnings.push(`The file was made or re-encoded by software (${editor[0]}), not straight off a camera.`);
  }
  if (!opts.capturedInApp && !text(tags.Make) && !text(tags.Model)) {
    warnings.push('The file names no camera make or model.');
  }
  if (durationSeconds > IMPLAUSIBLY_LONG_SECONDS) {
    warnings.push(`The video runs ${Math.round(durationSeconds / 60)} minutes, far longer than a walkthrough.`);
  }

  return { warnings, recordedAt: recorded === undefined ? undefined : new Date(recorded).toISOString() };
}

/** What the automatic check found, kept with the listing for whoever reviews
 *  it. `visuallyVerified` is always false here: nothing automated ever sets it. */
export type WalkthroughCheckRecord = {
  /** `camera_captured`: recorded with the in-app camera; the device reported a
   *  location (see `capture`) that sits near the pin. DEVICE-REPORTED, so it
   *  is evidence for a reviewer, never proof.
   *  `unanalysed`: the video analyser was unavailable, so the file itself was
   *  not inspected; the capture location was still checked.
   *  `gps_tag_only`: legacy, written before camera capture existed — a
   *  location tag inside an uploaded file sat near the pin. Never written now;
   *  only read back from old listings. */
  method: 'camera_captured' | 'unanalysed' | 'gps_tag_only';
  /** Legacy (`gps_tag_only`) rows only. */
  gpsTagWithinRadius?: boolean;
  visuallyVerified: false;
  /** The device-reported location at the end of the recording. Absent on legacy rows. */
  capture?: CaptureRecord;
  /** Legacy rows only; new rows carry the distance inside `capture`. */
  distanceMetres?: number;
  durationSeconds?: number;
  /** Where the duration came from: the file's own container, or the browser
   *  (a MediaRecorder WebM carries no duration). */
  durationSource?: 'file' | 'client_reported';
  recordedAt?: string;
  warnings: string[];
  checkedAt: string;
  /** TEST ONLY: the location checks were skipped (CAPTURE_LOCATION_BYPASS). */
  bypassed?: true;
};
