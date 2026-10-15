/** Date-only ("YYYY-MM-DD") strings are calendar dates, never instants: they
 *  are parsed as UTC midnight and only ever compared with other calendar
 *  dates, so the server's timezone cannot shift them. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Days since epoch for a calendar date, or NaN if it is not a real date. */
export function calendarDayNumber(iso: string): number {
  if (!ISO_DATE.test(iso)) return NaN;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== iso) return NaN;
  return ms / 86_400_000;
}

/** Today's calendar date in the server's local timezone, as a day number. */
export function todayDayNumber(now: Date = new Date()): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000;
}

/** Today's calendar date in India (Asia/Kolkata), as a day number — for rules
 *  tied to the property's local day rather than the server's timezone. */
export function todayDayNumberIST(now: Date = new Date()): number {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return calendarDayNumber(iso);
}

/** Inverse of calendarDayNumber: a day number back to an ISO calendar date. */
export function calendarDayToISO(dayNumber: number): string {
  return new Date(dayNumber * 86_400_000).toISOString().slice(0, 10);
}
