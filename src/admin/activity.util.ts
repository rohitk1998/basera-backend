// Pure bucketing for GET /api/admin/activity. India has no DST (fixed UTC+05:30), so day keys in
// Asia/Kolkata are computed with plain offset arithmetic.

export const ACTIVITY_RANGES = ['7d', '30d', '90d', '1y'] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];

export type ActivityPoint = {
  date: string;
  label: string;
  activity: number;
  users: number;
  listings: number;
  bookings: number;
};

export type DailyCount = { day: string; count: number };
export type ActivitySeries = { users: DailyCount[]; listings: DailyCount[]; bookings: DailyCount[] };

type Bucket = { date: string; label: string; endDate: string };

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const parseActivityRange = (raw: unknown): ActivityRange | null =>
  ACTIVITY_RANGES.find((range) => range === raw) ?? null;

/** YYYY-MM-DD of the given instant on the India calendar. */
export const istDayKey = (instant: Date): string => new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The UTC instant at which the given India calendar day starts. */
export const istDayStart = (day: string): Date => new Date(Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS);

const dayToMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const msToDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => msToDay(dayToMs(day) + n * DAY_MS);
const dayLabel = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;

const dailyBuckets = (today: string, days: number, label: (day: string) => string): Bucket[] =>
  Array.from({ length: days }, (_, i) => {
    const date = addDays(today, i - (days - 1));
    return { date, label: label(date), endDate: date };
  });

const weeklyBuckets = (today: string, weeks: number): Bucket[] =>
  Array.from({ length: weeks }, (_, i) => {
    const date = addDays(today, -(weeks * 7 - 1) + i * 7);
    return { date, label: dayLabel(date), endDate: addDays(date, 6) };
  });

const monthlyBuckets = (today: string, months: number): Bucket[] => {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  return Array.from({ length: months }, (_, i) => {
    const first = new Date(Date.UTC(year, month - (months - 1) + i, 1));
    const last = new Date(Date.UTC(year, month - (months - 1) + i + 1, 0));
    return { date: first.toISOString().slice(0, 10), label: MONTHS[first.getUTCMonth()], endDate: last.toISOString().slice(0, 10) };
  });
};

export const buildBuckets = (range: ActivityRange, now: Date): Bucket[] => {
  const today = istDayKey(now);
  switch (range) {
    case '7d':
      return dailyBuckets(today, 7, (day) => WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? day);
    case '30d':
      return dailyBuckets(today, 30, dayLabel);
    case '90d':
      return weeklyBuckets(today, 13);
    case '1y':
      return monthlyBuckets(today, 12);
  }
};

/** First India calendar day covered by the range; query rows created at or after istDayStart(this). */
export const activityWindowStart = (range: ActivityRange, now: Date): string => buildBuckets(range, now)[0]?.date ?? istDayKey(now);

const sumByBucket = (buckets: Bucket[], counts: DailyCount[]): number[] => {
  const totals = buckets.map(() => 0);
  for (const { day, count } of counts) {
    const index = buckets.findIndex((b) => day >= b.date && day <= b.endDate);
    if (index >= 0) totals[index] = (totals[index] ?? 0) + count;
  }
  return totals;
};

/** Zero-filled, oldest-first points. `activity` = users + listings + bookings in the bucket. */
export const buildActivityPoints = (range: ActivityRange, now: Date, series: ActivitySeries): ActivityPoint[] => {
  const buckets = buildBuckets(range, now);
  const users = sumByBucket(buckets, series.users);
  const listings = sumByBucket(buckets, series.listings);
  const bookings = sumByBucket(buckets, series.bookings);
  return buckets.map((bucket, i) => {
    const u = users[i] ?? 0;
    const l = listings[i] ?? 0;
    const b = bookings[i] ?? 0;
    return { date: bucket.date, label: bucket.label, activity: u + l + b, users: u, listings: l, bookings: b };
  });
};
