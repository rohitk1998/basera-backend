import { calendarDayNumber, calendarDayToISO } from '../common/calendar-date.util';

export const MAX_BUFFER_DAYS = 3;

export type DateRange = { start: string; end: string }; // end exclusive, ISO dates

export function clampBuffer(days: unknown): number {
  const n = Number(days);
  return Number.isInteger(n) ? Math.min(Math.max(n, 0), MAX_BUFFER_DAYS) : 0;
}

/** Extends an occupied range by the host's turnover buffer on both sides. */
export function bufferRange(r: DateRange, bufferDays: number): DateRange {
  const b = clampBuffer(bufferDays);
  return {
    start: calendarDayToISO(calendarDayNumber(r.start) - b),
    end: calendarDayToISO(calendarDayNumber(r.end) + b),
  };
}

/** Half-open overlap: [start, end). */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return calendarDayNumber(a.start) < calendarDayNumber(b.end) && calendarDayNumber(a.end) > calendarDayNumber(b.start);
}

/**
 * Occupied ranges that clash with the requested stay once the buffer is applied.
 * Call site: BookingsService.create (and the host calendar import) with the listing's buffer_days,
 * in addition to the existing no-overlap constraint.
 */
export function findConflicts(occupied: DateRange[], request: DateRange, bufferDays: number): DateRange[] {
  if (!(calendarDayNumber(request.end) > calendarDayNumber(request.start))) return [];
  return occupied.filter((o) => rangesOverlap(bufferRange(o, bufferDays), request));
}

export function hasConflict(occupied: DateRange[], request: DateRange, bufferDays: number): boolean {
  return findConflicts(occupied, request, bufferDays).length > 0;
}
