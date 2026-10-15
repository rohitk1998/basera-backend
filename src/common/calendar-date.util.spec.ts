import { calendarDayNumber, todayDayNumber, todayDayNumberIST } from './calendar-date.util';

describe('calendar-date.util', () => {
  it('parses date-only strings independent of timezone', () => {
    expect(calendarDayNumber('2026-11-03') - calendarDayNumber('2026-11-02')).toBe(1);
    expect(calendarDayNumber('1970-01-02')).toBe(1);
  });

  it('rejects non-dates', () => {
    expect(calendarDayNumber('2026-02-31')).toBeNaN();
    expect(calendarDayNumber('2026-11-02T00:00:00')).toBeNaN();
    expect(calendarDayNumber('nope')).toBeNaN();
  });

  it('uses the local calendar day for today', () => {
    const late = new Date(2026, 10, 2, 23, 59);
    const early = new Date(2026, 10, 2, 0, 1);
    expect(todayDayNumber(late)).toBe(todayDayNumber(early));
    expect(todayDayNumber(late)).toBe(calendarDayNumber('2026-11-02'));
  });
});

describe('todayDayNumberIST', () => {
  it('uses the Asia/Kolkata calendar day, not UTC', () => {
    // 20:00 UTC on 1 Nov is already 01:30 on 2 Nov in India.
    expect(todayDayNumberIST(new Date('2026-11-01T20:00:00Z'))).toBe(calendarDayNumber('2026-11-02'));
    expect(todayDayNumberIST(new Date('2026-11-01T18:00:00Z'))).toBe(calendarDayNumber('2026-11-01'));
  });
});
