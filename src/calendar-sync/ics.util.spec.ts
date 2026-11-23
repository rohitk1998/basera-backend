import { buildIcs, parseIcs } from './ics.util';

describe('ics.util', () => {
  it('builds a CRLF calendar with all-day events', () => {
    const out = buildIcs('Room, A', [{ uid: 'b1@RhenBasera', summary: 'Booked', start: '2026-11-20', end: '2026-11-25' }], new Date('2026-11-16T10:00:00Z'));
    expect(out.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(out).toContain('X-WR-CALNAME:Room\\, A');
    expect(out).toContain('DTSTART;VALUE=DATE:20261120\r\n');
    expect(out).toContain('DTEND;VALUE=DATE:20261125\r\n');
    expect(out).toContain('DTSTAMP:20261116T100000Z');
    expect(out.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('round-trips through the parser', () => {
    const out = buildIcs('x', [{ uid: 'u1', summary: 's', start: '2026-12-01', end: '2026-12-04' }]);
    expect(parseIcs(out)).toEqual([{ uid: 'u1', start: '2026-12-01', end: '2026-12-04' }]);
  });

  it('parses date-times, folded lines, missing DTEND, and skips cancelled', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:a',
      'DTSTART:20261120T140000Z',
      'DTEND:20261122T110000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:long',
      ' er',
      'DTSTART;VALUE=DATE:20261201',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:c',
      'STATUS:CANCELLED',
      'DTSTART;VALUE=DATE:20261210',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:bad',
      'DTSTART:garbage',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(parseIcs(text)).toEqual([
      { uid: 'a', start: '2026-11-20', end: '2026-11-23' },
      { uid: 'longer', start: '2026-12-01', end: '2026-12-02' },
    ]);
  });
});

describe('assertIcalBody', () => {
  const { assertIcalBody, NOT_ICAL_MESSAGE } = require('./ics.util');
  it('accepts a calendar, case-insensitively', () => {
    expect(() => assertIcalBody('  begin:vcalendar\r\nEND:VCALENDAR\r\n')).not.toThrow();
  });
  it.each(['', '   ', '<html>login</html>', 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT'])('rejects %j', (body) => {
    expect(() => assertIcalBody(body)).toThrow(NOT_ICAL_MESSAGE);
  });
});
