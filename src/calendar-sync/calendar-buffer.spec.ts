import { ConflictException } from '@nestjs/common';
import { CalendarSyncService } from './calendar-sync.service';

describe('assertDatesFree with turnover buffer', () => {
  const mk = (buffer: number | null, blocks: any[]) => {
    const qb: any = { where: () => qb, andWhere: () => qb, getMany: async () => blocks };
    const ds: any = {
      query: async (sql: string) => (sql.includes('to_regclass') ? [{ ok: buffer !== null }] : [{ buffer_days: buffer }]),
    };
    return new CalendarSyncService({} as any, { createQueryBuilder: () => qb } as any, {} as any, {} as any, ds);
  };
  const block = [{ starts_on: '2026-12-05', ends_on: '2026-12-09' }];
  it('rejects a stay inside the buffer of an imported block', async () => {
    await expect(mk(2, block).assertDatesFree('l', '2026-12-10', '2026-12-12')).rejects.toBeInstanceOf(ConflictException);
  });
  it('allows the same stay with no buffer', async () => {
    await expect(mk(0, block).assertDatesFree('l', '2026-12-10', '2026-12-12')).resolves.toBeUndefined();
    await expect(mk(null, block).assertDatesFree('l', '2026-12-10', '2026-12-12')).resolves.toBeUndefined();
  });
});
