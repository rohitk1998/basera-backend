import type { CaptureRecord } from './capture.util';

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

export const WALKTHROUGH_GPS_TOLERANCE_METRES = 200;

export const WALKTHROUGH_MIN_DURATION_SECONDS = 15;

export function formatDistance(metres: number): string {
  if (metres >= 1000) {
    return `${(metres / 1000).toFixed(1)} km`;
  }
  return `${Math.round(metres)}m`;
}

const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

const STALE_AFTER_DAYS = 30;

const IMPLAUSIBLY_LONG_SECONDS = 20 * 60;

const EDITOR_PATTERN = /lavf|ffmpeg|handbrake|premiere|capcut|final cut|davinci|imovie|kdenlive|shotcut|\bobs\b|screenrecord/i;

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

function tagTimeMs(value: unknown): number | undefined {
  let ms: number | undefined;
  if (value && typeof value === 'object') {
    const v = value as { toMillis?: () => number; toDate?: () => Date };
    if (typeof v.toMillis === 'function') ms = v.toMillis();
    else if (typeof v.toDate === 'function') ms = v.toDate().getTime();
  } else if (typeof value === 'string') {
    const iso = value.trim().replace(/^(\d{4}):(\d{2}):(\d{2})[ T]/, '$1-$2-$3T');
    ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
  } else if (typeof value === 'number') {
    ms = value;
  }
  return typeof ms === 'number' && Number.isFinite(ms) && ms > Date.UTC(1980, 0, 1) ? ms : undefined;
}

const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

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
  failure?: string;
  warnings: string[];
  recordedAt?: string;
};

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

export type WalkthroughCheckRecord = {
  method: 'camera_captured' | 'unanalysed' | 'gps_tag_only';
  gpsTagWithinRadius?: boolean;
  visuallyVerified: false;
  capture?: CaptureRecord;
  distanceMetres?: number;
  durationSeconds?: number;
  durationSource?: 'file' | 'client_reported';
  recordedAt?: string;
  warnings: string[];
  checkedAt: string;
  bypassed?: true;
};
