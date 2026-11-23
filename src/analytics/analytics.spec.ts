import { METRICS, SECTIONS, metricsFor, toResult, unavailable } from './analytics.metrics';
import { AnalyticsService } from './analytics.service';
import { MAX_WINDOW_DAYS, WindowError, resolveWindow } from './analytics.window';

describe('window', () => {
  const now = new Date('2026-11-21T10:30:45Z');
  it('defaults to the last 30 days, floored to the minute', () => {
    const w = resolveWindow(undefined, undefined, now);
    expect(w.to.toISOString()).toBe('2026-11-21T10:30:00.000Z');
    expect(w.from.toISOString()).toBe('2026-10-22T10:30:00.000Z');
    expect(w.isDefault).toBe(true);
  });
  it('bare `to` date is inclusive of that day', () => {
    expect(resolveWindow('2026-11-01', '2026-11-03', now).to.toISOString()).toBe('2026-11-04T00:00:00.000Z');
  });
  it('rejects bad, reversed and oversized windows', () => {
    expect(() => resolveWindow('nope', undefined, now)).toThrow(WindowError);
    expect(() => resolveWindow('2026-11-05', '2026-11-01', now)).toThrow(/before/);
    expect(() => resolveWindow('2020-01-01', '2026-01-01', now)).toThrow(String(MAX_WINDOW_DAYS));
  });
});

describe('metric catalogue', () => {
  it('has a complete definition for every metric and unique keys', () => {
    expect(new Set(METRICS.map((m) => m.key)).size).toBe(METRICS.length);
    for (const m of METRICS) {
      expect(m.definition.numerator).toBeTruthy();
      expect(m.definition.window).toBeTruthy();
      expect(m.definition.source).toBeTruthy();
      expect(m.requires.length).toBeGreaterThan(0);
    }
    for (const s of SECTIONS) expect(metricsFor(s).length).toBeGreaterThan(0);
  });
  it('SQL is read-only and uses only $1/$2', () => {
    for (const m of METRICS) {
      const sql = m.build();
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
      const ph = [...sql.matchAll(/\$(\d+)/g)].map((x) => Number(x[1]));
      expect(Math.max(0, ...ph)).toBeLessThanOrEqual(2);
    }
  });
  it('never counts unclaimed candidates as inventory', () => {
    const sql = METRICS.find((m) => m.key === 'published_bookable')!.build();
    expect(sql).toMatch(/is_discovered = false/);
    expect(sql).toMatch(/booking_eligible = true/);
    expect(sql).toMatch(/status = 'live'/);
    expect(METRICS.find((m) => m.key === 'unclaimed_candidates')!.build()).toMatch(/is_discovered = true/);
  });
  it('listing views and cost per host need their (possibly absent) tables', () => {
    expect(METRICS.find((m) => m.key === 'listing_views')!.requires).toEqual(['listing_views']);
    expect(METRICS.find((m) => m.key === 'acquisition_cost_per_activated_host')!.requires).toContain('acquisition_costs');
  });
  it('maps pg rows (bigint strings) to numbers and nulls stay null', () => {
    const spec = METRICS.find((m) => m.key === 'booking_conversion_rate')!;
    expect(toResult(spec, { numerator: '3', denominator: '12', value: 0.25 })).toMatchObject({ value: 0.25, numerator: 3, denominator: 12 });
    expect(toResult(spec, { numerator: '0', denominator: '0', value: null }).value).toBeNull();
    expect(unavailable(spec, 'missing_tables', ['bookings'])).toMatchObject({ value: null, unavailable: 'missing_tables' });
  });
});

describe('AnalyticsService', () => {
  const mkDs = (present: string[], failKey?: string) => ({
    query: jest.fn(async (sql: string, args: any[]) => {
      if (sql.includes('to_regclass')) return (args[0] as string[]).map((t) => ({ t, present: present.includes(t) }));
      if (failKey && sql.includes(failKey)) throw new Error('boom');
      return [{ value: '7' }];
    }),
  });
  const cache = () => { const m = new Map<string, string>(); return { get: jest.fn(async (k: string) => m.get(k) ?? null), set: jest.fn(async (k: string, v: string) => { m.set(k, v); return true; }) }; };

  it('returns null (not an error) for missing sources and for failing queries', async () => {
    const svc = new AnalyticsService(mkDs(['listings', 'host_leads', 'property_claims'], 'decided_at') as any);
    const r: any = await svc.section('acquisition');
    expect(r.metrics.discovered_candidates.value).toBe(7);
    expect(r.metrics.verified_properties).toMatchObject({ value: null, unavailable: 'missing_tables' });
    expect(r.metrics.claims_approved).toMatchObject({ value: null, unavailable: 'error' });
  });

  it('caches 60s and admins can bust the cache', async () => {
    const ds = mkDs(['listings', 'host_leads', 'property_claims', 'listing_status_history']);
    const c = cache();
    const svc = new AnalyticsService(ds as any, c as any);
    const first: any = await svc.section('acquisition', '2026-11-01', '2026-11-05');
    expect(first.cached).toBe(false);
    expect(c.set).toHaveBeenCalledWith(expect.stringContaining('analytics:acquisition:'), expect.any(String), 60);
    const calls = ds.query.mock.calls.length;
    expect(((await svc.section('acquisition', '2026-11-01', '2026-11-05')) as any).cached).toBe(true);
    expect(ds.query.mock.calls.length).toBe(calls);
    expect(((await svc.section('acquisition', '2026-11-01', '2026-11-05', true)) as any).cached).toBe(false);
  });

  it('turns window errors into 400s', () => {
    expect(() => new AnalyticsService({} as any).window('bad')).toThrow(/ISO/);
  });
});
