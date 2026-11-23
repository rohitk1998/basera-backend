import { AdminLookupsService } from './admin-lookups.service';

const make = (rows: any[]) => new AdminLookupsService({ query: async () => rows } as any, {} as any);

describe('AdminLookupsService.staff', () => {
  it('offers only the primary admin when that account exists', async () => {
    const out = await make([
      { id: '1', name: 'Other Admin', email: 'other@example.com' },
      { id: '2', name: 'Main', email: 'admin@rhenbasera.com' },
    ]).staff();
    expect(out.data).toEqual([{ id: '2', name: 'Main', email: 'admin@rhenbasera.com' }]);
  });

  it('falls back to every admin when no account has the primary email, so the picker is never empty', async () => {
    const out = await make([{ id: '1', name: 'A', email: 'a@example.com' }, { id: '3', name: 'B', email: 'b@example.com' }]).staff();
    expect(out.data).toHaveLength(2);
  });
});
