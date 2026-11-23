import { NotFoundException } from '@nestjs/common';
import { ListingsService } from './listings.service';
import { rowToListing } from './listing-mapper';
import { PhoneRevealService } from './phone-reveal.service';
import { HostVettingService } from '../host-vetting/host-vetting.service';
import { BookingsService } from '../bookings/bookings.service';

const discovered: any = {
  id: 'd1', host_id: null, status: 'discovered', is_discovered: true,
  draft_data: { property_details: { title: 'X' } }, created_at: new Date(),
};

/** Records EVERY where (including nested Brackets) and every raw SQL string, for all query builders. */
function recordingService(rawRows: any[] = []) {
  const wheres: string[] = [];
  const sqls: string[] = [];
  const qb: any = new Proxy({}, {
    get: (_t, n: string) => {
      if (n === 'getCount') return async () => 0;
      if (n === 'getRawOne') return async () => ({ total: 0, owner_total: 0 });
      if (n === 'getMany') return async () => [];
      if (n === 'getRawMany') return async () => rawRows;
      return (...a: any[]) => {
        if (n === 'where' || n === 'andWhere' || n === 'orWhere') {
          if (a[0] && typeof a[0].whereFactory === 'function') a[0].whereFactory(qb);
          else wheres.push(String(a[0]));
        }
        return qb;
      };
    },
  });
  const repo: any = {
    createQueryBuilder: () => qb,
    query: async (s: string) => { sqls.push(s); return []; },
    findOne: async () => discovered,
  };
  const profiles: any = { findOne: async () => null };
  const service = new ListingsService(repo, profiles, {} as any,
    { getCachedTranslationsBatch: async () => new Map(), warmTranslation: () => {} } as any,
    { getVersion: async () => '1', get: async () => null, set: async () => true } as any);
  return { service, wheres, sqls };
}

describe('discovered listings are never public', () => {
  it('findLive query builder excludes discovered', async () => {
    const { service, wheres } = recordingService();
    await service.findLive({});
    expect(wheres.some((w) => w.includes('is_discovered = false'))).toBe(true);
  });

  it('a bare findLive (and every default reader) never admits discovered rows', async () => {
    const place = [{ district: 'Kullu', place: 'Manali', count: '1', min_rate: null, min_disc: null, cover_url: null, cover_at: null }];
    const h = recordingService(place);
    await h.service.findLive({});
    await h.service.findLive({ facets: true, q: 'manali', district: 'Kullu' });
    await h.service.findLive({ facets: true });
    await h.service.getTownSummaries();
    await (h.service as any).placeVocab();
    const all = [...h.wheres, ...h.sqls];
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) {
      expect(s).not.toMatch(/is_discovered\s*=\s*true/i);
      expect(s).not.toMatch(/disc_(district|tehsil|lat|lng)/);
      expect(s).not.toMatch(/\bOR\b[^']*is_discovered/i);
    }
    expect(h.wheres.length).toBeGreaterThan(0);
    for (const w of h.wheres.filter((w) => w.includes('is_discovered'))) expect(w).toContain('l.is_discovered = false');
  });

  it('getTownSummaries SQL and place-facet wheres exclude discovered rows', async () => {
    const place = [{ district: 'Kullu', place: 'Manali', count: '1', min_rate: null, min_disc: null, cover_url: null, cover_at: null }];
    const { service, wheres, sqls } = recordingService(place);
    await service.getTownSummaries();
    expect(sqls.length).toBeGreaterThan(0); // the preview query ran
    for (const q of sqls) expect(q).toContain('is_discovered = false');
    expect(wheres.every((w) => w.includes('is_discovered = false'))).toBe(true);
  });

  it('only the explicit includeDiscovered path adds a discovered arm', async () => {
    const h = recordingService();
    await h.service.findLive({ includeDiscovered: true });
    expect(h.wheres.some((w) => /is_discovered\s*=\s*true/.test(w))).toBe(true);
    expect(h.wheres).toContain("l.status = 'live' AND l.is_discovered = false");
    const bare = recordingService();
    await bare.service.findLive({ includeDiscovered: false });
    expect(bare.wheres.some((w) => /is_discovered\s*=\s*true/.test(w))).toBe(false);
  });

  it('findOnePublic 404s a discovered row for anonymous, a user, and an id-matching "owner"', async () => {
    const { service } = recordingService();
    await expect(service.findOnePublic('d1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.findOnePublic('d1', undefined, { userId: 'u1', isAdmin: false })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.findOnePublic('d1', undefined, { userId: undefined as any, isAdmin: false })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('findOnePublic lets an admin see a discovered row without a host', async () => {
    const { service } = recordingService();
    const res = await service.findOnePublic('d1', undefined, { userId: 'a1', isAdmin: true });
    expect(res.host.id).toBe('');
    // Flagged so the guest-facing stay page uses the discovered view, not this empty stub.
    expect(res.listing.discovered).toBe(true);
  });

  it('place vocabulary raw SQL excludes discovered', async () => {
    const { service, sqls } = recordingService();
    await (service as any).placeVocab();
    expect(sqls.length).toBeGreaterThan(0);
    for (const s of sqls) expect(s).toContain('l.is_discovered = false');
  });

  it('mapper never marks a discovered row verified, even if status were live', () => {
    expect(rowToListing({ ...discovered, status: 'live' }).verified).toBe(false);
    expect(rowToListing({ ...discovered, status: 'live', is_discovered: false, host_id: 'h' }).verified).toBe(true);
  });

  it('phone reveal rejects discovered rows (even forced live) before touching the host', async () => {
    const users: any = { findOne: jest.fn(async () => ({ id: 'g', phone: '+911', email_verified_at: new Date(), banned_at: null, phone_verified_at: new Date() })) };
    const listings: any = { findOne: async () => ({ ...discovered, status: 'live' }) };
    const svc = new PhoneRevealService(users, listings, {} as any, { get: () => '' } as any);
    await expect(svc.reveal('g', 'd1', undefined)).rejects.toBeInstanceOf(Error);
  });

  it('booking create rejects discovered rows', async () => {
    const listingsRepo: any = { findOne: async () => ({ ...discovered, status: 'live' }) };
    const svc = new (BookingsService as any)(null, null, listingsRepo);
    await expect(svc.create('u1', { listingId: 'd1' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('host-vetting due list excludes discovered', async () => {
    const sqls: string[] = [];
    const repo: any = { query: async (s: string) => { sqls.push(s); return []; } };
    const svc = new HostVettingService({} as any, {} as any, repo, { get: () => undefined } as any);
    await svc.listDue();
    expect(sqls.length).toBeGreaterThan(0);
    for (const s of sqls) expect(s).toContain('l.is_discovered = false');
  });
});
