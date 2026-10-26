const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function calendarDayNumber(iso: string): number {
  if (!ISO_DATE.test(iso)) return NaN;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== iso) return NaN;
  return ms / 86_400_000;
}

export function todayDayNumber(now: Date = new Date()): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000;
}

export function todayDayNumberIST(now: Date = new Date()): number {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return calendarDayNumber(iso);
}

export function calendarDayToISO(dayNumber: number): string {
  return new Date(dayNumber * 86_400_000).toISOString().slice(0, 10);
}
