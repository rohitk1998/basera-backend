import { calendarDayNumber, calendarDayToISO } from '../common/calendar-date.util';

export type IcsEvent = {
  uid: string;
  summary: string;
  /** Inclusive first night, YYYY-MM-DD. */
  start: string;
  /** Exclusive end day, YYYY-MM-DD (iCal all-day DTEND semantics). */
  end: string;
};

export type ParsedRange = { uid: string; start: string; end: string };

export const MAX_PARSED_EVENTS = 2000;

const escapeText = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

const compact = (iso: string) => iso.replace(/-/g, '');

/** Fold to 75 octets per RFC 5545 (continuation lines start with one space). */
const fold = (line: string): string => {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let limit = 75;
  for (const ch of line) {
    if (Buffer.byteLength(current + ch) > limit) {
      parts.push(current);
      current = ch;
      limit = 74;
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.join('\r\n ');
};

export const buildIcs = (calendarName: string, events: IcsEvent[], now: Date = new Date()): string => {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RhenBasera//Calendar Sync//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(e.start)}`,
      `DTEND;VALUE=DATE:${compact(e.end)}`,
      `SUMMARY:${escapeText(e.summary)}`,
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
};

const unfold = (text: string): string[] =>
  text
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');

/** "20261120" or "20261120T100000Z" -> ISO date + whether a non-midnight time was present. */
const parseIcsDate = (value: string): { iso: string; timed: boolean } | null => {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  if (isNaN(calendarDayNumber(iso))) return null;
  const timed = m[4] !== undefined && !(m[4] === '00' && m[5] === '00' && m[6] === '00');
  return { iso, timed };
};

const addDays = (iso: string, days: number) => calendarDayToISO(calendarDayNumber(iso) + days);

type RawEvent = { uid?: string; status?: string; dtstart?: string; dtend?: string };

/** Extracts busy date ranges from an iCal feed. Cancelled and unparseable events are skipped; recurrence is not expanded. */
export const parseIcs = (text: string): ParsedRange[] => {
  const ranges: ParsedRange[] = [];
  let current: RawEvent | null = null;
  let index = 0;

  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) {
        const range = finish(current, index++);
        if (range) ranges.push(range);
        if (ranges.length >= MAX_PARSED_EVENTS) break;
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).split(';')[0].toUpperCase();
    const value = line.slice(colon + 1);
    if (name === 'UID') current.uid = value.trim();
    else if (name === 'STATUS') current.status = value.trim().toUpperCase();
    else if (name === 'DTSTART') current.dtstart = value;
    else if (name === 'DTEND') current.dtend = value;
  }
  return ranges;
};

const finish = (raw: RawEvent, index: number): ParsedRange | null => {
  if (raw.status === 'CANCELLED' || !raw.dtstart) return null;
  const start = parseIcsDate(raw.dtstart);
  if (!start) return null;
  const parsedEnd = raw.dtend ? parseIcsDate(raw.dtend) : null;
  let end = parsedEnd ? (parsedEnd.timed ? addDays(parsedEnd.iso, 1) : parsedEnd.iso) : addDays(start.iso, 1);
  if (calendarDayNumber(end) <= calendarDayNumber(start.iso)) end = addDays(start.iso, 1);
  return { uid: raw.uid || `event-${index}`, start: start.iso, end };
};

export const NOT_ICAL_MESSAGE = 'That link did not return an iCal calendar.';

/** Guards against replacing blocks with [] when the URL returned HTML, an empty body or a truncated feed. */
export const assertIcalBody = (body: string): string => {
  const upper = body.trim().toUpperCase();
  if (!upper.includes('BEGIN:VCALENDAR') || !upper.includes('END:VCALENDAR')) {
    throw new Error(NOT_ICAL_MESSAGE);
  }
  return body;
};
