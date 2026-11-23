import { NotFoundException } from '@nestjs/common';
import { DiscoveredPublicController } from './discovered-public.controller';
import { discoveredOpenSql } from './discovered-predicate';

const ID = '11111111-1111-4111-8111-111111111111';
const OPEN = discoveredOpenSql('');
const row = { id: ID, external_place_id: 'place-aaaaaaaaaa', discovery_destination: 'Manali', lat: 32.2, lng: 77.1 };
const D: any = { name: 'Pine Cottage', address: 'x', rating: 4.5, ratingCount: 3, mapsUrl: 'u', photoName: 'p/0', photoNames: ['p/0', 'p/1'], summary: 's', amenities: [], reviews: [] };

function make(rows: any[] = [row]) {
  const sqls: { sql: string; params: any[] }[] = [];
  const ds: any = { query: jest.fn(async (sql: string, params: any[] = []) => { sqls.push({ sql: sql.replace(/\s+/g, ' '), params }); return rows; }) };
  const places: any = { getPhoto: jest.fn(async () => ({ contentType: 'image/jpeg', body: Buffer.from('x') })) };
  const details: any = { get: jest.fn(async () => D) };
  const ctl = new DiscoveredPublicController(ds, places, details);
  const res: any = { headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v; }, send: jest.fn() };
  return { ctl, sqls, ds, places, details, res };
}

describe('DiscoveredPublicController', () => {
  it('the OPEN predicate is the shared, unaliased one', () => {
    expect(OPEN).toContain('is_discovered = true');
    expect(OPEN).toContain("discovery_source = 'google_places'");
    expect(OPEN).not.toMatch(/\bl\./);
    for (const s of ['ARCHIVED', 'HOST_DECLINED', 'CONVERTED_TO_PROPERTY']) expect(OPEN).toContain(`'${s}'`);
  });

  it('list and one both run the OPEN predicate in their SQL', async () => {
    const t = make();
    await t.ctl.list();
    await t.ctl.one(ID);
    expect(t.sqls).toHaveLength(2);
    for (const q of t.sqls) expect(q.sql).toContain(OPEN.replace(/\s+/g, ' '));
  });

  it('list and one fetch live details through the shared service', async () => {
    const t = make();
    const out: any = await t.ctl.list();
    expect(t.details.get).toHaveBeenCalledWith('place-aaaaaaaaaa');
    expect(out.items[0]).toMatchObject({ id: ID, name: 'Pine Cottage', verified: false, district: 'Kullu' });
  });

  it('one() 404s when the row is not open', async () => {
    const t = make([]);
    await expect(t.ctl.one(ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(t.details.get).not.toHaveBeenCalled();
  });

  it('photo route 404s a non-open id before touching Google', async () => {
    const t = make([]);
    await expect(t.ctl.photo(ID, t.res)).rejects.toBeInstanceOf(NotFoundException);
    expect(t.sqls[0].sql).toContain(OPEN.replace(/\s+/g, ' '));
    expect(t.details.get).not.toHaveBeenCalled();
    expect(t.places.getPhoto).not.toHaveBeenCalled();
  });

  it('photo route serves an open id with the CDN-friendly Cache-Control', async () => {
    const t = make();
    await t.ctl.photo(ID, t.res, '1');
    expect(t.res.headers['Cache-Control']).toBe('public, max-age=3600, stale-while-revalidate=86400');
    expect(t.places.getPhoto).toHaveBeenCalledWith('p/1', expect.any(Number));
    expect(t.res.send).toHaveBeenCalled();
  });

  it('photo route 404s when Google has no such photo', async () => {
    const t = make();
    await expect(t.ctl.photo(ID, t.res, '9')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps the legacy town->district filter for list()', async () => {
    const t = make();
    await t.ctl.list(undefined, undefined, 'Kangra');
    expect(t.sqls[0].params[0]).toEqual(expect.arrayContaining(['bir', 'dharamshala']));
    expect(t.sqls[0].params[0]).not.toContain('manali');
    const none: any = await make().ctl.list('atlantis');
    expect(none.items).toEqual([]);
  });
});
