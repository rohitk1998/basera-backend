import { isCaptureRecord, isWithinTolerance, withDistanceFrom, type CaptureRecord } from './capture.util';
import type { WalkthroughCheckRecord } from './walkthrough-gps.util';

export type PhotoEvidence = {
  url: string;
  room?: string;

  state: 'captured' | 'legacy' | 'out_of_range';
  capture?: CaptureRecord;

  bypassed?: true;
};

export type WalkthroughEvidence = {
  state: 'captured' | 'unanalysed' | 'legacy' | 'out_of_range' | 'missing';
  method?: WalkthroughCheckRecord['method'];
  capture?: CaptureRecord;
  durationSeconds?: number;
  durationSource?: 'file' | 'client_reported';
  warnings: string[];
  videoUrl?: string;

  bypassed?: true;
};

export type CaptureEvidence = {
  status: 'passed' | 'submitted' | 'not_started';

  problems: string[];
  pin?: { lat: number; lng: number };
  walkthrough: WalkthroughEvidence;
  photos: PhotoEvidence[];

  deviceReported: true;
};

const hasPin = (lat: unknown, lng: unknown): boolean => typeof lat === 'number' && typeof lng === 'number';

export function evaluateCaptureEvidence(draft: Record<string, any>): CaptureEvidence {
  const property = draft.property_details || draft.property || draft.basics || {};
  const telemetry = draft.telemetry || {};
  const pin = hasPin(property.lat, property.lng) ? { lat: property.lat as number, lng: property.lng as number } : undefined;

  const measure = (record: CaptureRecord): CaptureRecord => (pin ? withDistanceFrom(record, pin) : record);

  const check: Partial<WalkthroughCheckRecord> | undefined =
    telemetry.walkthroughCheck && typeof telemetry.walkthroughCheck === 'object' ? telemetry.walkthroughCheck : undefined;
  const walkthrough: WalkthroughEvidence = {
    state: 'missing',
    method: check?.method,
    durationSeconds: check?.durationSeconds,
    durationSource: check?.durationSource,
    warnings: Array.isArray(check?.warnings) ? (check!.warnings as string[]) : [],
    videoUrl: typeof telemetry.walkthroughVideoUrl === 'string' ? telemetry.walkthroughVideoUrl : undefined,
  };
  if (telemetry.walkthroughPassed === true) {
    if (isCaptureRecord(check?.capture)) {
      const capture = measure(check!.capture as CaptureRecord);
      walkthrough.capture = capture;
      if (check?.bypassed === true || capture.bypassed === true) {
        walkthrough.bypassed = true;
        walkthrough.state = 'captured';
      } else {
        walkthrough.state = !isWithinTolerance(capture) ? 'out_of_range' : check?.method === 'unanalysed' ? 'unanalysed' : 'captured';
      }
    } else {
      walkthrough.state = 'legacy';
    }
  }

  const stored: Record<string, unknown> = draft.captures?.photos && typeof draft.captures.photos === 'object' ? draft.captures.photos : {};
  const photos: PhotoEvidence[] = (Array.isArray(property.photos) ? property.photos : []).flatMap(
    (p: { url?: string; room?: string } | string): PhotoEvidence[] => {
      const url = typeof p === 'string' ? p : p?.url;
      if (typeof url !== 'string' || !url) return [];
      const room = typeof p === 'string' ? undefined : p.room;
      const record = stored[url];
      if (!isCaptureRecord(record)) return [{ url, room, state: 'legacy' }];
      const capture = measure(record);
      if (capture.bypassed === true) return [{ url, room, state: 'captured', capture, bypassed: true }];
      return [{ url, room, state: isWithinTolerance(capture) ? 'captured' : 'out_of_range', capture }];
    },
  );

  const problems: string[] = [];
  switch (walkthrough.state) {
    case 'missing':
      problems.push('no walkthrough video');
      break;
    case 'legacy':
      problems.push('walkthrough uploaded before camera capture (no capture data)');
      break;
    case 'out_of_range':
      problems.push('walkthrough captured too far from the pin');
      break;
  }
  const legacy = photos.filter((p) => p.state === 'legacy').length;
  const far = photos.filter((p) => p.state === 'out_of_range').length;
  if (photos.length === 0) problems.push('no photos');
  if (legacy > 0) problems.push(`${legacy} ${legacy === 1 ? 'photo' : 'photos'} uploaded before camera capture (no capture data)`);
  if (far > 0) problems.push(`${far} ${far === 1 ? 'photo' : 'photos'} captured too far from the pin`);
  if (!pin) problems.push('no pin on the listing');

  if (walkthrough.bypassed === true || photos.some((p) => p.bypassed === true)) {
    problems.push('location check was bypassed (test mode) — approving needs an audited override');
  }

  const status = walkthrough.state === 'missing' ? 'not_started' : problems.length === 0 ? 'passed' : 'submitted';
  return { status, problems, pin, walkthrough, photos, deviceReported: true };
}

export function captureCheckTrulyPassed(draft: Record<string, any>): boolean {
  if (evaluateCaptureEvidence(draft).status !== 'passed') return false;
  const overrides: { unmetChecks?: unknown }[] = Array.isArray(draft.approval_overrides) ? draft.approval_overrides : [];
  return !overrides.some(
    (o) => Array.isArray(o?.unmetChecks) && o.unmetChecks.some((c) => typeof c === 'string' && c.startsWith('Camera capture')),
  );
}
