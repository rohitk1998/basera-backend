import { activityWindowStart, buildActivityPoints, buildBuckets, istDayKey, istDayStart, parseActivityRange } from './activity.util';

const NOW = new Date('2025-11-15T20:00:00Z'); // 2025-11-16 01:30 in India
const empty = { users: [], listings: [], bookings: [] };

describe('activity.util', () => {
  it('parses only known ranges', () => {
    expect(parseActivityRange('7d')).toBe('7d');
    expect(parseActivityRange('1y')).toBe('1y');
    expect(parseActivityRange('2y')).toBeNull();
    expect(parseActivityRange(undefined)).toBeNull();
  });

  it('uses the India calendar day', () => {
    expect(istDayKey(NOW)).toBe('2025-11-16');
    expect(istDayKey(new Date('2025-11-15T18:29:59Z'))).toBe('2025-11-15');
    expect(istDayStart('2025-11-16').toISOString()).toBe('2025-11-15T18:30:00.000Z');
  });

  it('7d: seven daily points, oldest first, weekday labels', () => {
    const points = buildActivityPoints('7d', NOW, empty);
    expect(points.map((p) => p.date)[0]).toBe('2025-11-10');
    expect(points.map((p) => p.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(points.every((p) => p.activity === 0)).toBe(true);
  });

  it('30d: thirty daily points with day-month labels', () => {
    const points = buildActivityPoints('30d', NOW, empty);
    expect(points).toHaveLength(30);
    expect(points[29]).toMatchObject({ date: '2025-11-16', label: '16 Nov' });
    expect(points[0]?.date).toBe('2025-10-18');
  });

  it('90d: thirteen weekly buckets ending today', () => {
    const buckets = buildBuckets('90d', NOW);
    expect(buckets).toHaveLength(13);
    expect(buckets[12]?.endDate).toBe('2025-11-16');
    expect(buckets[0]?.date).toBe('2025-08-18');
  });

  it('1y: twelve calendar months including the current one', () => {
    const points = buildActivityPoints('1y', NOW, empty);
    expect(points).toHaveLength(12);
    expect(points[0]).toMatchObject({ date: '2024-12-01', label: 'Dec' });
    expect(points[11]).toMatchObject({ date: '2025-11-01', label: 'Nov' });
    expect(activityWindowStart('1y', NOW)).toBe('2024-12-01');
  });

  it('sums users + listings + bookings and ignores rows outside the window', () => {
    const points = buildActivityPoints('7d', NOW, {
      users: [{ day: '2025-11-16', count: 2 }, { day: '2025-01-01', count: 9 }],
      listings: [{ day: '2025-11-16', count: 1 }],
      bookings: [{ day: '2025-11-12', count: 4 }],
    });
    expect(points[6]).toMatchObject({ users: 2, listings: 1, bookings: 0, activity: 3 });
    expect(points[2]).toMatchObject({ bookings: 4, activity: 4 });
  });

  it('aggregates days into weekly and monthly buckets', () => {
    const series = { ...empty, users: [{ day: '2025-11-16', count: 1 }, { day: '2025-11-10', count: 2 }, { day: '2025-10-30', count: 5 }] };
    const weeks = buildActivityPoints('90d', NOW, series);
    expect(weeks[12]?.users).toBe(3);
    expect(weeks[10]?.users).toBe(5);
    const months = buildActivityPoints('1y', NOW, series);
    expect(months[11]?.users).toBe(3);
    expect(months[10]?.users).toBe(5);
  });
});
