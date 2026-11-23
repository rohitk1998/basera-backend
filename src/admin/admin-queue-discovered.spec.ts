import { AdminService } from './admin.service';

/** Discovered (Google) stubs must never show up in the host Properties Queue, its counts, or the overview stats. */
function setup() {
  const wheres: string[] = [];
  const qb: any = {
    where: (w: string) => { wheres.push(w); return qb; },
    andWhere: (w: string) => { wheres.push(w); return qb; },
    orderBy: () => qb, skip: () => qb, take: () => qb, select: () => qb, addSelect: () => qb, groupBy: () => qb,
    getManyAndCount: async () => [[], 0],
    getMany: async () => [],
    getRawMany: async () => [],
    getRawOne: async () => ({ total: '0', passed: '0' }),
  };
  const listings: any = { createQueryBuilder: () => qb, count: async () => 0 };
  const profiles: any = { find: async () => [], count: async () => 0 };
  const svc = new AdminService(listings, profiles, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, wheres };
}

describe('admin properties queue and discovered rows', () => {
  it('getProperties excludes discovered rows from the list and from the status counts', async () => {
    const { svc, wheres } = setup();
    await svc.getProperties();
    expect(wheres.filter((w) => w === 'l.is_discovered = false').length).toBeGreaterThanOrEqual(2);
  });

  it('getStats excludes discovered rows from the status counts', async () => {
    const { svc, wheres } = setup();
    await svc.getStats().catch(() => undefined);
    expect(wheres).toContain('l.is_discovered = false');
  });
});
