export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 366;

export interface Window {
  from: Date;
  to: Date;
  /** true when the caller supplied neither bound (default window). */
  isDefault: boolean;
}

export class WindowError extends Error {}

function parse(label: string, v: string): Date {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new WindowError(`${label} must be an ISO 8601 date or timestamp`);
  return d;
}

/**
 * Resolve ?from&to. Defaults: to = now (floored to the minute so cache keys are stable), from = to - 30d.
 * A bare date for `to` (YYYY-MM-DD) is inclusive: the window runs to the end of that UTC day.
 */
export function resolveWindow(from?: string, to?: string, now: Date = new Date()): Window {
  const flooredNow = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  let end = to ? parse('to', to) : flooredNow;
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) end = new Date(end.getTime() + 86_400_000);
  const start = from ? parse('from', from) : new Date(end.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
  if (start >= end) throw new WindowError('from must be before to');
  if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_WINDOW_DAYS) throw new WindowError(`window may not exceed ${MAX_WINDOW_DAYS} days`);
  return { from: start, to: end, isDefault: !from && !to };
}
