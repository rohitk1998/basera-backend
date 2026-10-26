import { isCaptureRecord, type CaptureRecord } from './capture.util';

export const SPEEDTEST_TTL_SECONDS = 15 * 60;

export const WIFI_TEST_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export const SPEEDTEST_MIN_BYTES = 1024 * 1024;
export const SPEEDTEST_MAX_BYTES = 25 * 1024 * 1024;

export const SPEEDTEST_MAX_STREAMS = 24;

export const CLIENT_FIGURE_SLACK = 1.5;

export const WORK_READY_MBPS = 20;

export const WIFI_AMENITY = 'Wifi';
export const WORK_CATEGORY = 'work';

export const WORK_CATEGORY_MESSAGE =
  'The Work category needs a Wi-Fi test above 20 Mbps measured at the property. Run the Wi-Fi test in the Wi-Fi step.';

export type WifiAnswer = 'yes' | 'no' | 'later';

export function speedtestKey(userId: string, testId: string): string {
  return `speedtest:${userId}:${testId}`;
}

export function speedtestSamplesKey(userId: string, testId: string, direction: 'download' | 'upload'): string {
  return `${speedtestKey(userId, testId)}:${direction}`;
}

export function wifiTestTokenKey(userId: string, token: string): string {
  return `wifi-test-token:${userId}:${token}`;
}

export type StreamSample = { bytes: number; firstAt: number; lastAt: number };

export type WifiResult = {
  downMbps: number;
  upMbps: number;
  pingMs: number;
  jitterMs: number;
  connectionType: string | null;
  testedAt: string;
  capture: { distanceFromPinM: number; accuracyM: number; capturedAt: string };
};

export type StoredWifi = WifiResult & { answer: WifiAnswer };

export function clampDownloadBytes(raw: unknown): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return SPEEDTEST_MAX_BYTES;
  return Math.min(SPEEDTEST_MAX_BYTES, Math.max(SPEEDTEST_MIN_BYTES, Math.floor(n)));
}

export function parseSamples(raw: string[]): StreamSample[] {
  const out: StreamSample[] = [];
  for (const entry of raw) {
    try {
      const s = JSON.parse(entry);
      if (Number.isFinite(s?.bytes) && Number.isFinite(s?.firstAt) && Number.isFinite(s?.lastAt) && s.bytes > 0) {
        out.push({ bytes: s.bytes, firstAt: s.firstAt, lastAt: s.lastAt });
      }
    } catch {
      /* a malformed sample is ignored */
    }
  }
  return out;
}

export function serverMbps(samples: StreamSample[]): number | null {
  if (samples.length === 0) return null;
  const bytes = samples.reduce((sum, s) => sum + s.bytes, 0);
  const first = Math.min(...samples.map((s) => s.firstAt));
  const last = Math.max(...samples.map((s) => s.lastAt));
  const seconds = (last - first) / 1000;
  if (!(seconds > 0) || bytes <= 0) return null;
  return (bytes * 8) / seconds / 1e6;
}

export function cappedMbps(clientMbps: number, server: number | null): number {
  if (server === null) return 0;
  const client = Number.isFinite(clientMbps) && clientMbps > 0 ? clientMbps : 0;
  return client > server * CLIENT_FIGURE_SLACK ? server : client;
}

export const roundMbps = (v: number) => Math.round(v * 10) / 10;
export const roundMs = (v: number) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

export function buildWifiResult(input: {
  downMbps: number;
  upMbps: number;
  pingMs: number;
  jitterMs?: number;
  connectionType?: string;
  capture: CaptureRecord;
  now?: number;
}): WifiResult {
  return {
    downMbps: roundMbps(input.downMbps),
    upMbps: roundMbps(input.upMbps),
    pingMs: roundMs(input.pingMs),
    jitterMs: roundMs(input.jitterMs ?? 0),
    connectionType: input.connectionType?.trim().slice(0, 32) || null,
    testedAt: new Date(input.now ?? Date.now()).toISOString(),
    capture: {
      distanceFromPinM: input.capture.distanceFromPinM,
      accuracyM: input.capture.accuracyM,
      capturedAt: input.capture.capturedAt,
    },
  };
}

export function isWifiResult(v: unknown): v is WifiResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const c = r.capture as Record<string, unknown> | undefined;
  return (
    typeof r.downMbps === 'number' &&
    typeof r.upMbps === 'number' &&
    typeof r.pingMs === 'number' &&
    typeof r.testedAt === 'string' &&
    !!c &&
    typeof c.distanceFromPinM === 'number'
  );
}

export type WifiTokenValue = { lat: number; lng: number; record: CaptureRecord; result: WifiResult };

export function isWifiTokenValue(v: unknown): v is WifiTokenValue {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return typeof t.lat === 'number' && typeof t.lng === 'number' && isCaptureRecord(t.record) && isWifiResult(t.result);
}

export function applyWifiAmenity(amenities: string[], wifi: unknown): string[] {
  const rest = amenities.filter((a) => a !== WIFI_AMENITY);
  return isMeasuredYes(wifi) ? [WIFI_AMENITY, ...rest] : rest;
}

export function workCategoryAllowed(wifi: unknown): boolean {
  return isMeasuredYes(wifi) && wifi.downMbps > WORK_READY_MBPS;
}

export function isMeasuredYes(wifi: unknown): wifi is StoredWifi {
  return isWifiResult(wifi) && (wifi as Partial<StoredWifi>).answer === 'yes';
}
