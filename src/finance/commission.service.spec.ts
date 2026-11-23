import { CommissionService } from './commission.service';

function build(opts: { agreement?: any; cap?: number; capRow?: any; env?: number; throwOnAgreement?: boolean }) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('from commission_agreements')) {
      if (opts.throwOnAgreement) throw new Error('relation does not exist');
      return opts.agreement ? [opts.agreement] : [];
    }
    if (sql.includes('with active as')) return [opts.capRow ?? { total: 10, is_active: true, rank: 5 }];
    throw new Error('unexpected sql ' + sql);
  });
  const settings: any = { get: jest.fn(async (_k: string, d: number) => opts.cap ?? d) };
  const config: any = { get: () => opts.env ?? 6 };
  return { svc: new CommissionService({ query } as any, settings, config), query, settings };
}
const agr = (rate_bps: number, extra: any = {}) => ({ id: 'a1', scope: 'global', rate_bps, free_period_cap: null, ...extra });

describe('CommissionService.resolveRate', () => {
  it('orders candidates property > host > global in SQL and returns the winner', async () => {
    const { svc, query } = build({ agreement: agr(0, { id: 'p1', scope: 'property' }) });
    const r = await svc.resolveRate('l1', 'h1');
    expect(r).toMatchObject({ rateBps: 0, agreementId: 'p1', scope: 'property', rule: 'agreement' });
    expect(query.mock.calls[0][0]).toMatch(/case scope when 'property' then 0 when 'host' then 1 else 2/);
  });

  it('seeded free-launch global agreement (0 bps) needs no cap lookup', async () => {
    const { svc, query } = build({ agreement: agr(0) });
    expect((await svc.resolveRate('l1', 'h1')).rateBps).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('free-cap: a positive rate is zeroed while the property is inside the first N (default cap 100)', async () => {
    const { svc, settings } = build({ agreement: agr(600), capRow: { total: 100, is_active: true, rank: 100 } });
    const r = await svc.resolveRate('l1', 'h1');
    expect(r).toMatchObject({ rateBps: 0, rule: 'free-cap', agreementId: 'a1' });
    expect(settings.get).toHaveBeenCalledWith('free_listing_cap', 100);
  });

  it('beyond the cap the agreement rate applies; early properties keep the free period', async () => {
    expect((await build({ agreement: agr(600), capRow: { total: 150, is_active: true, rank: 101 } }).svc.resolveRate('l', 'h')).rateBps).toBe(600);
    expect((await build({ agreement: agr(600), capRow: { total: 150, is_active: true, rank: 7 } }).svc.resolveRate('l', 'h')).rateBps).toBe(0);
  });

  it('a not-yet-active property is free only while active count < cap', async () => {
    expect((await build({ agreement: agr(600), capRow: { total: 99, is_active: false, rank: 99 } }).svc.resolveRate('l', 'h')).rateBps).toBe(0);
    expect((await build({ agreement: agr(600), capRow: { total: 100, is_active: false, rank: 100 } }).svc.resolveRate('l', 'h')).rateBps).toBe(600);
  });

  it('settings cap is configurable and the agreement free_period_cap overrides it', async () => {
    const a = build({ agreement: agr(600), cap: 5, capRow: { total: 10, is_active: true, rank: 8 } });
    expect((await a.svc.resolveRate('l', 'h')).rateBps).toBe(600);
    const b = build({ agreement: agr(600, { free_period_cap: 20 }), cap: 5, capRow: { total: 10, is_active: true, rank: 8 } });
    expect((await b.svc.resolveRate('l', 'h')).rateBps).toBe(0);
  });

  it('cap 0 disables the free-cap rule', async () => {
    const { svc, query } = build({ agreement: agr(600), cap: 0 });
    expect((await svc.resolveRate('l', 'h')).rateBps).toBe(600);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('env fallback (percent -> bps) when no agreement or the table is unavailable', async () => {
    expect(await build({ env: 6 }).svc.resolveRate('l', 'h')).toEqual({ rateBps: 600, agreementId: null, rule: 'env-fallback', scope: null });
    expect((await build({ env: 5, throwOnAgreement: true }).svc.resolveRate('l', 'h')).rateBps).toBe(500);
  });
});
