import { AttractionsService } from './attractions.service';

const row = (name: string, lat: number, lng: number) => ({ id: name, slug: name, name, lat, lng, district: 'Kullu', category: 'lake', status: 'published', popularity: 1, youtubeIds: [] }) as any;

describe('AttractionsService.nearby', () => {
  it('returns attractions within the radius, nearest first, with straight-line km', async () => {
    const rows = [row('far', 32.5, 77.4), row('near', 32.25, 77.19), row('mid', 32.3, 77.25)];
    const qb: any = { where: () => qb, andWhere: () => qb, orderBy: () => qb, take: () => qb, getMany: async () => rows };
    const svc = new AttractionsService({ createQueryBuilder: () => qb } as any, {} as any, {} as any, {} as any);
    const out = await svc.nearby(32.24, 77.19, { radiusKm: 30, limit: 5 });
    expect(out.map((a) => a.name)).toEqual(['near', 'mid']);
    expect(out[0].awayKm).toBeGreaterThan(0);
    expect(out[0].awayKm).toBeLessThan(out[1].awayKm);
  });
});
