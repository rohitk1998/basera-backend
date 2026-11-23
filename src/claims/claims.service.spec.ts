import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { RESPONSE_MESSAGE } from '../common/decorators/response-message.decorator';
import { setLockBackends } from '../common/leader-lock';
import { AdminClaimsController, ClaimsController } from './claims.controller';
import { ClaimEvidenceEntity, ClaimEventEntity, PropertyClaimEntity } from './claims.entities';
import { ClaimsScheduler } from './claims.scheduler';
import { ClaimsService, hashInvitationToken, maskName } from './claims.service';
import { PropertyAccess } from './property-access.service';

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100, 1)]);
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const L1 = '44444444-4444-4444-8444-444444444444';
const C1 = '55555555-5555-4555-8555-555555555555';
const C2 = '66666666-6666-4666-8666-666666666666';

type Claim = Partial<PropertyClaimEntity> & { id: string };

function build(opts: { claims?: Claim[]; evidence?: any[]; listing?: any; banned?: string[]; inv?: any; consume?: boolean } = {}) {
  const claims: Claim[] = opts.claims ?? [];
  const evidence: any[] = opts.evidence ?? [];
  const events: any[] = [];
  const listing = { id: L1, host_id: null as string | null, is_discovered: true, status: 'discovered', ...(opts.listing ?? {}) };
  const members: any[] = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    if (/FROM property_claims WHERE id/.test(sql)) return claims.filter((c) => c.id === params[0]);
    if (/FROM listings WHERE id/.test(sql)) return [listing];
    if (/^\s*UPDATE listings/.test(sql)) {
      if (listing.is_discovered && !listing.host_id) {
        Object.assign(listing, { host_id: params[0], is_discovered: false, status: 'draft' });
        return [[{ id: params[1] }], 1];
      }
      return [[], 0];
    }
    if (/INSERT INTO property_members/.test(sql)) { members.push(params); return []; }
    return [];
  });
  const em: any = {
    query,
    create: (_e: any, v: any) => ({ id: C1, ...v }),
    save: async (v: any) => { claims.push(v); return v; },
    insert: async (e: any, v: any) => { if (e === ClaimEventEntity) events.push(v); },
    update: async (e: any, id: string, patch: any) => { if (e === PropertyClaimEntity) Object.assign(claims.find((c) => c.id === id)!, patch); },
    find: async (e: any, o: any) => (e === PropertyClaimEntity ? claims.filter((c) => c.listing_id === o.where.listing_id) : []),
    findOne: async (e: any, o: any) => (e.name === 'UserEntity' ? { id: o.where.id, banned_at: opts.banned?.includes(o.where.id) ? new Date() : null } : null),
  };
  // serialise transactions like row locks would
  let chain: Promise<unknown> = Promise.resolve();
  const dataSource: any = {
    query, getRepository: () => ({ findOne: async () => null }),
    transaction: (cb: any) => { const r = chain.then(() => cb(em)); chain = r.catch(() => undefined); return r; },
  };
  const claimsRepo: any = {
    findOne: jest.fn(async ({ where }: any) => claims.find((c) => c.id === where.id && (!where.claimant_user_id || c.claimant_user_id === where.claimant_user_id)) ?? null),
    save: jest.fn(async (c: any) => c), find: jest.fn(async () => claims),
  };
  const evRepo: any = {
    find: jest.fn(async ({ where }: any) => evidence.filter((e) => e.claim_id === where.claim_id)),
    findOne: jest.fn(async ({ where }: any) => evidence.find((e) => e.id === where.id && e.claim_id === where.claim_id) ?? null),
    create: (v: any) => ({ id: 'ev' + evidence.length, uploaded_at: new Date(), ...v }),
    save: jest.fn(async (v: any) => { evidence.push(v); return v; }),
    update: jest.fn(async (id: string, p: any) => Object.assign(evidence.find((e) => e.id === id), p)),
    createQueryBuilder: () => ({ where() { return this; }, take() { return this; }, getMany: async () => evidence.filter((e) => !e.purged_at && e.retention_until <= new Date()) }),
  };
  const eventsRepo: any = { insert: jest.fn(async (v: any) => { events.push(v); }), find: jest.fn(async () => events) };
  const usersRepo: any = { findOne: jest.fn(async ({ where }: any) => ({ id: where.id, banned_at: opts.banned?.includes(where.id) ? new Date() : null })) };
  const storage: any = { uploadPrivate: jest.fn(async () => undefined), remove: jest.fn(async () => undefined), createSignedDownloadUrl: jest.fn(async () => 'https://signed') };
  const invitations: any = {
    find: jest.fn(async () => opts.inv ?? null),
    consume: jest.fn(async () => opts.consume ?? true),
  };
  const crm = { markConverted: jest.fn(async () => null) };
  const redis = { incrementVersion: jest.fn(async () => 2) };
  const svc = new ClaimsService(dataSource, claimsRepo, evRepo, eventsRepo, usersRepo, storage, invitations, crm as any, undefined, redis as any);
  return { redis, svc, claims, evidence, events, listing, members, storage, invitations, crm, evRepo, query };
}

const submitted = (id: string, user: string, extra: Partial<Claim> = {}): Claim => ({
  id, listing_id: L1, claimant_user_id: user, role: 'owner', state: 'SUBMITTED', ...extra,
});

describe('claim approval', () => {
  it('hands the listing over as a DRAFT (never live) and grants membership + CRM conversion', async () => {
    const t = build({ claims: [submitted(C1, U1)] });
    const r = await t.svc.approve(ADMIN, C1);
    expect(r.listingStatus).toBe('draft');
    expect(t.listing).toMatchObject({ host_id: U1, status: 'draft', is_discovered: false });
    expect(t.members).toHaveLength(1);
    expect(t.crm.markConverted).toHaveBeenCalledWith(L1, U1);
    expect(t.events.map((e) => e.action)).toContain('approved');
  });

  it('an unapproved claim never activates a listing (draft/submitted/rejected cannot be approved)', async () => {
    for (const state of ['DRAFT', 'MORE_INFORMATION_REQUIRED', 'REJECTED', 'WITHDRAWN'] as const) {
      const t = build({ claims: [submitted(C1, U1, { state })] });
      await expect(t.svc.approve(ADMIN, C1)).rejects.toThrow(/only submitted|not allowed/);
      expect(t.listing).toMatchObject({ host_id: null, is_discovered: true });
    }
  });

  it('refuses self-approval and banned claimants', async () => {
    const t = build({ claims: [submitted(C1, ADMIN)] });
    await expect(t.svc.approve(ADMIN, C1)).rejects.toThrow(/own claim/);
    const b = build({ claims: [submitted(C1, U1)], banned: [U1] });
    await expect(b.svc.approve(ADMIN, C1)).rejects.toThrow(/cannot be approved/);
    expect(b.listing.host_id).toBeNull();
  });

  it('double approval race: only one of two concurrent approvals wins', async () => {
    const t = build({ claims: [submitted(C1, U1), submitted(C2, U2)] });
    const results = await Promise.allSettled([t.svc.approve(ADMIN, C1), t.svc.approve(ADMIN, C2)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(t.listing.host_id).toBe(U1);
    expect(t.claims.filter((c) => c.state === 'APPROVED')).toHaveLength(1);
  });

  it('refuses when the listing was claimed behind our back (guarded UPDATE matches 0 rows)', async () => {
    const t = build({ claims: [submitted(C1, U1)], listing: { host_id: U2, is_discovered: false } });
    await expect(t.svc.approve(ADMIN, C1)).rejects.toThrow(/already claimed/);
    expect(t.claims[0].state).toBe('SUBMITTED');
  });

  it('auto-rejects competing open claims with an event', async () => {
    const t = build({ claims: [submitted(C1, U1), submitted(C2, U2, { state: 'UNDER_REVIEW' })] });
    await t.svc.approve(ADMIN, C1);
    expect(t.claims.find((c) => c.id === C2)!.state).toBe('REJECTED');
    expect(t.events.find((e) => e.action === 'auto_rejected')).toMatchObject({ claim_id: C2 });
  });

  it('bumps the /stays search cache version on approval (the row leaves the discovered grid)', async () => {
    const t = build({ claims: [submitted(C1, U1)] });
    await t.svc.approve(ADMIN, C1);
    expect(t.redis.incrementVersion).toHaveBeenCalledTimes(1);
    expect(t.redis.incrementVersion).toHaveBeenCalledWith('listings:search:version');
  });

  it('a failed redis bump never undoes the approval, and a rejected approval does not bump', async () => {
    const t = build({ claims: [submitted(C1, U1)] });
    t.redis.incrementVersion.mockRejectedValue(new Error('redis down'));
    await expect(t.svc.approve(ADMIN, C1)).resolves.toMatchObject({ state: 'APPROVED' });
    const u = build({ claims: [submitted(C1, U1, { state: 'REJECTED' })] });
    await expect(u.svc.approve(ADMIN, C1)).rejects.toThrow();
    expect(u.redis.incrementVersion).not.toHaveBeenCalled();
  });

  it('CRM failure does not undo the approval', async () => {
    const t = build({ claims: [submitted(C1, U1)] });
    t.crm.markConverted.mockRejectedValue(new Error('down'));
    await expect(t.svc.approve(ADMIN, C1)).resolves.toMatchObject({ state: 'APPROVED' });
  });
});

describe('invitation tokens', () => {
  it('rejects unknown / expired / replayed tokens identically', async () => {
    const none = build({ inv: null });
    await expect(none.svc.start(U1, { invitationToken: 'x'.repeat(43), role: 'owner' })).rejects.toThrow(/invalid, expired or already used/);
    const replay = build({ inv: { invitationId: 'i1', listingId: L1 }, consume: false });
    await expect(replay.svc.start(U1, { invitationToken: 'x'.repeat(43), role: 'owner' })).rejects.toThrow(/invalid, expired or already used/);
    expect(replay.claims).toHaveLength(0); // no claim kept when consume lost the race
  });

  it('valid token creates a DRAFT claim and looks up by sha256 hash, never the raw token', async () => {
    const t = build({ inv: { invitationId: 'i1', listingId: L1 } });
    const tok = 'a'.repeat(43);
    const r = await t.svc.start(U1, { invitationToken: tok, role: 'manager' });
    expect(r.state).toBe('DRAFT');
    expect(t.invitations.find).toHaveBeenCalledWith(hashInvitationToken(tok));
    expect(hashInvitationToken(tok)).not.toContain(tok);
  });

  it('banned users cannot claim; already-claimed listings are not claimable; needs exactly one source', async () => {
    await expect(build({ banned: [U1] }).svc.start(U1, { listingId: L1, role: 'owner' })).rejects.toThrow(/cannot claim/);
    await expect(build({ listing: { host_id: U2, is_discovered: false } }).svc.start(U1, { listingId: L1, role: 'owner' })).rejects.toThrow(/not available/);
    await expect(build().svc.start(U1, { role: 'owner' })).rejects.toThrow(/either/);
  });
});

describe('IDOR', () => {
  it('another user gets 404 for claim, evidence upload, submit, withdraw and draft save', async () => {
    const t = build({ claims: [{ ...submitted(C1, U1), state: 'DRAFT' }] });
    await expect(t.svc.getMine(U2, C1)).rejects.toThrow(/not found/i);
    await expect(t.svc.uploadEvidence(U2, C1, 'other', { buffer: PDF, size: PDF.length, mimetype: 'application/pdf' })).rejects.toThrow(/not found/i);
    await expect(t.svc.submit(U2, C1)).rejects.toThrow(/not found/i);
    await expect(t.svc.withdraw(U2, C1)).rejects.toThrow(/not found/i);
    await expect(t.svc.saveDraft(U2, C1, { businessName: 'x' })).rejects.toThrow(/not found/i);
    await expect(t.svc.deleteEvidence(U2, C1, 'e')).rejects.toThrow(/not found/i);
    expect(t.storage.uploadPrivate).not.toHaveBeenCalled();
  });

  it('claimant-facing payload never exposes storage paths, hashes or internal reviewer ids', async () => {
    const t = build({ claims: [{ ...submitted(C1, U1), state: 'DRAFT' }], evidence: [{ id: 'e1', claim_id: C1, kind: 'other', mime: 'application/pdf', size: 5, storage_path: 'secret/path.pdf', sha256: 'h', uploaded_at: new Date() }] });
    const json = JSON.stringify(await t.svc.getMine(U1, C1));
    expect(json).not.toMatch(/secret\/path|sha256|reviewer/);
  });

  it('admin signed URL is 120s and audited; purged evidence is unavailable', async () => {
    const t = build({ evidence: [{ id: 'e1', claim_id: C1, storage_path: 'p', mime: 'application/pdf' }, { id: 'e2', claim_id: C1, storage_path: 'q', purged_at: new Date() }] });
    const r = await t.svc.adminEvidenceUrl(ADMIN, C1, 'e1');
    expect(t.storage.createSignedDownloadUrl).toHaveBeenCalledWith('claim-evidence', 'p', 120);
    expect(r.expiresInSeconds).toBe(120);
    expect(t.events.at(-1)).toMatchObject({ action: 'evidence_viewed', actor_id: ADMIN });
    await expect(t.svc.adminEvidenceUrl(ADMIN, C1, 'e2')).rejects.toThrow(/not found/i);
  });
});

describe('evidence limits', () => {
  const draft = () => build({ claims: [{ ...submitted(C1, U1), state: 'DRAFT' }] });
  const file = (b: Buffer, mimetype: string) => ({ buffer: b, size: b.length, mimetype });

  it('accepts a real PDF into the private bucket under a server-generated name', async () => {
    const t = draft();
    await t.svc.uploadEvidence(U1, C1, 'utility_bill', file(PDF, 'application/pdf'));
    const [bucket, path] = t.storage.uploadPrivate.mock.calls[0];
    expect(bucket).toBe('claim-evidence');
    expect(path).toMatch(new RegExp(`^${C1}/[0-9a-f-]{36}\\.pdf$`));
    expect(t.evidence[0].sha256).toHaveLength(64);
  });
  it('rejects disallowed mime, spoofed content, oversize, empty, duplicate and over-count', async () => {
    const t = draft();
    await expect(t.svc.uploadEvidence(U1, C1, 'other', file(PDF, 'text/html'))).rejects.toThrow(/Only PDF/);
    await expect(t.svc.uploadEvidence(U1, C1, 'other', file(Buffer.from('<html>'), 'application/pdf'))).rejects.toThrow(/does not match/);
    await expect(t.svc.uploadEvidence(U1, C1, 'other', file(Buffer.alloc(11 * 1024 * 1024), 'application/pdf'))).rejects.toThrow(/MB or smaller/);
    await expect(t.svc.uploadEvidence(U1, C1, 'other', undefined)).rejects.toThrow(/Choose a file/);
    await expect(t.svc.uploadEvidence(U1, C1, 'bogus', file(PDF, 'application/pdf'))).rejects.toThrow(/Unknown evidence/);
    await t.svc.uploadEvidence(U1, C1, 'other', file(PDF, 'application/pdf'));
    await expect(t.svc.uploadEvidence(U1, C1, 'other', file(PDF, 'application/pdf'))).rejects.toThrow(/already uploaded/);
    for (let i = 0; i < 9; i++) await t.svc.uploadEvidence(U1, C1, 'other', file(Buffer.concat([PDF, Buffer.from([i])]), 'application/pdf'));
    await expect(t.svc.uploadEvidence(U1, C1, 'other', file(Buffer.concat([PDF, Buffer.from('z')]), 'application/pdf'))).rejects.toThrow(/at most 10/);
  });
  it('cannot upload once submitted', async () => {
    const t = build({ claims: [submitted(C1, U1)] });
    await expect(t.svc.uploadEvidence(U1, C1, 'other', file(PDF, 'application/pdf'))).rejects.toThrow(/no longer/);
  });
  it('submit needs terms, contact, authority text and a non-photo document', async () => {
    const base: Claim = { ...submitted(C1, U1), state: 'DRAFT', contact_phone: '+919999999999', authority_statement: 'I am the registered owner of this homestay.', terms_accepted_at: new Date(), terms_version: 'v' };
    const docs = [{ id: 'e1', claim_id: C1, kind: 'utility_bill' }];
    await expect(build({ claims: [{ ...base, terms_accepted_at: null }], evidence: docs }).svc.submit(U1, C1)).rejects.toThrow(/terms/);
    await expect(build({ claims: [base], evidence: [] }).svc.submit(U1, C1)).rejects.toThrow(/supporting document/);
    await expect(build({ claims: [base], evidence: [{ id: 'p', claim_id: C1, kind: 'property_photo' }] }).svc.submit(U1, C1)).rejects.toThrow(/photos alone/);
    await expect(build({ claims: [{ ...base, authority_statement: 'short' }], evidence: docs }).svc.submit(U1, C1)).rejects.toThrow(/authority/);
    await expect(build({ claims: [base], evidence: docs, banned: [U1] }).svc.submit(U1, C1)).rejects.toThrow(/cannot claim/);
    const ok = build({ claims: [base], evidence: docs });
    await expect(ok.svc.submit(U1, C1)).resolves.toMatchObject({ state: 'SUBMITTED' });
  });
});

describe('retention purge', () => {
  it('deletes storage objects past retention and marks purged_at; failures retry later', async () => {
    const past = new Date(Date.now() - 1000);
    const t = build({ evidence: [
      { id: 'a', claim_id: C1, storage_path: 'a.pdf', retention_until: past, purged_at: null },
      { id: 'b', claim_id: C1, storage_path: 'b.pdf', retention_until: past, purged_at: null },
    ] });
    t.storage.remove.mockImplementation(async (_b: string, p: string[]) => { if (p[0] === 'b.pdf') throw new Error('boom'); });
    expect(await t.svc.purgeExpired()).toEqual({ purged: 1, failed: 1 });
    expect(t.evidence[0].purged_at).toBeInstanceOf(Date);
    expect(t.evidence[1].purged_at).toBeNull();
  });
  it('scheduler purges only when it wins the leader lock', async () => {
    const s = { purgeExpired: jest.fn().mockResolvedValue({ purged: 0, failed: 0 }) };
    setLockBackends([{ acquire: async () => null }]);
    await new ClaimsScheduler(s as any).purge();
    expect(s.purgeExpired).not.toHaveBeenCalled();
    setLockBackends([{ acquire: async () => async () => undefined }]);
    await new ClaimsScheduler(s as any).purge();
    expect(s.purgeExpired).toHaveBeenCalledTimes(1);
    setLockBackends(undefined);
  });
});

describe('misc', () => {
  it('maskName hides most letters', () => {
    expect(maskName('Sunrise Cottage')).toBe('S****** C******');
    expect(maskName('')).toBeNull();
  });

  it('PropertyAccess.canManage: host or live member only', async () => {
    const mk = (listing: any, count: number) => new PropertyAccess(
      { findOne: async () => listing } as any,
      { createQueryBuilder: () => ({ where() { return this; }, getCount: async () => count }) } as any,
    );
    expect(await mk({ id: L1, host_id: U1 }, 0).canManage(U1, L1)).toBe(true);
    expect(await mk({ id: L1, host_id: U1 }, 1).canManage(U2, L1)).toBe(true);
    expect(await mk({ id: L1, host_id: U1 }, 0).canManage(U2, L1)).toBe(false);
    expect(await mk({ id: L1, host_id: null, is_discovered: true }, 0).canManage(U2, L1)).toBe(false);
    expect(await mk(null, 1).canManage(U1, L1)).toBe(false);
  });

  it('every mutating claims handler declares @ResponseMessage', () => {
    const METHODS: Record<number, string> = { [RequestMethod.POST]: 'POST', [RequestMethod.PUT]: 'PUT', [RequestMethod.PATCH]: 'PATCH', [RequestMethod.DELETE]: 'DELETE' };
    const missing: string[] = [];
    for (const c of [ClaimsController, AdminClaimsController]) {
      for (const name of Object.getOwnPropertyNames(c.prototype)) {
        const h = (c.prototype as any)[name];
        if (typeof h !== 'function') continue;
        const m = Reflect.getMetadata('method', h);
        if (m !== undefined && m in METHODS && !Reflect.getMetadata(RESPONSE_MESSAGE, h)) missing.push(`${c.name}.${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('admin enrichment', () => {
  const setup = () => {
    const m = build({ claims: [submitted(C1, U1, { contact_phone: '+919876543210' } as any)] });
    (m.svc as any).claims.createQueryBuilder = () => {
      const qb: any = { orderBy: () => qb, addOrderBy: () => qb, andWhere: () => qb, skip: () => qb, take: () => qb, getManyAndCount: async () => [m.claims, m.claims.length] };
      return qb;
    };
    m.query.mockImplementation(async (sql: string) => {
      if (/FROM users/.test(sql)) return [{ id: U1, full_name: 'Asha Rao', email: 'asha@example.com', phone: '+919876543210' }];
      if (/FROM listings WHERE id = ANY/.test(sql)) return [{ id: L1, discovery_destination: 'Manali', discovery_state: 'claim_pending' }];
      return [];
    });
    return m;
  };
  it('list masks claimant contact and includes listing destination/state', async () => {
    const { svc } = setup();
    const { items } = await svc.adminList({});
    expect(items[0].claimant).toEqual({ id: U1, name: 'Asha Rao', email: 'a***@example.com', phone: '*********3210' });
    expect(items[0].listing).toEqual({ id: L1, destination: 'Manali', discovery_state: 'claim_pending' });
  });
  it('detail returns the claimant in full', async () => {
    const { svc } = setup();
    const d = await svc.adminGet(C1);
    expect(d.claimant).toMatchObject({ email: 'asha@example.com', phone: '+919876543210' });
    expect(d.listing?.destination).toBe('Manali');
  });
});
