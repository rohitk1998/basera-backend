import { BadRequestException, ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { build, CHECKS, good, img, jpeg, NONCE, PEPPER } from './host-verification.testkit';
import { hashIdNumber } from './id-number.util';
import { challengesFor, issueLivenessToken } from './liveness-token.util';

// Decoding is exercised for real in image.util.spec.ts (needs the sharp native binary); here it is a stub
// that rejects anything shorter than a plausible image, like a truncated JPEG.
jest.mock('./image.util', () => ({
  ...jest.requireActual('./image.util'),
  reencodeToJpeg: async (b: Buffer, label: string) => {
    if (b.length < 8) throw new BadRequestException(`${label} could not be read as an image. Please retake it.`);
    return { buffer: Buffer.from(b), width: 500, height: 500 };
  },
}));

const submitted = { status: 'submitted', id_number_hash: 'HASH', doc_type: 'driving_license', doc_path: 'u1/c1/id.jpg', liveness_paths: ['a', 'b', 'c'] };
const uniqueErr = Object.assign(new Error('dup'), { code: '23505' });

describe('startConsent', () => {
  it('503s without a pepper (at consent, not only submit)', async () => {
    const { svc } = build({}, { cfg: {} });
    await expect(svc.startConsent('u1', 'dpdp-host-id-v1')).rejects.toThrow(/temporarily unavailable/);
  });
  it('issues a signed token and a server-chosen challenge pair', async () => {
    const { svc, cases, users } = build();
    users.findOne.mockResolvedValue({ id: 'u1', is_id_verified: false, banned_at: null });
    cases.findOne.mockResolvedValue(null);
    const res = await svc.startConsent('u1', 'dpdp-host-id-v1');
    expect(res.caseId).toBe('new-case');
    expect(res.liveness.challenges).toHaveLength(2);
    expect(res.liveness.token).toMatch(/^\d+\./);
  });
  it('concurrent start: a 23505 on insert returns the existing open case', async () => {
    const { svc, cases, users } = build();
    users.findOne.mockResolvedValue({ id: 'u1', is_id_verified: false, banned_at: null });
    cases.findOne.mockResolvedValueOnce(null).mockResolvedValue({ id: 'winner', status: 'consented', liveness_nonce: NONCE });
    cases.insert.mockRejectedValue(uniqueErr);
    const res = await svc.startConsent('u1', 'dpdp-host-id-v1');
    expect(res.caseId).toBe('winner');
  });
  it('blocks a banned user and enforces the rejection cooldown and attempt cap', async () => {
    const a = build();
    a.users.findOne.mockResolvedValue({ id: 'u1', banned_at: new Date() });
    await expect(a.svc.startConsent('u1', 'dpdp-host-id-v1')).rejects.toThrow(ForbiddenException);

    const b = build();
    b.users.findOne.mockResolvedValue({ id: 'u1', is_id_verified: false, banned_at: null });
    b.cases.findOne.mockResolvedValue(null);
    b.cases.count.mockResolvedValue(5);
    await expect(b.svc.startConsent('u1', 'dpdp-host-id-v1')).rejects.toThrow(HttpException);

    const c = build();
    c.users.findOne.mockResolvedValue({ id: 'u1', is_id_verified: false, banned_at: null });
    c.cases.findOne.mockResolvedValueOnce(null).mockResolvedValue({ reviewed_at: new Date() });
    c.cases.count.mockResolvedValue(1);
    await expect(c.svc.startConsent('u1', 'dpdp-host-id-v1')).rejects.toMatchObject({ status: 429 });
  });
});

describe('submit: liveness binding and images', () => {
  it('requires a valid token', async () => {
    const { svc, storage } = build();
    await expect(svc.submit('u1', 'c1', await good({ livenessToken: undefined }))).rejects.toThrow(/liveness/);
    await expect(svc.submit('u1', 'c1', await good({ livenessToken: '1.abc' }))).rejects.toThrow(/liveness/);
    expect(storage.uploadPrivate).not.toHaveBeenCalled();
  });
  it('rejects a token for another case or user, and an expired one', async () => {
    const { svc } = build();
    const other = issueLivenessToken('other', 'u1', NONCE, Date.now() + 1e5, PEPPER);
    await expect(svc.submit('u1', 'c1', await good({ livenessToken: other }))).rejects.toThrow(BadRequestException);
    const old = issueLivenessToken('c1', 'u1', NONCE, Date.now() - 1, PEPPER);
    await expect(svc.submit('u1', 'c1', await good({ livenessToken: old }))).rejects.toThrow(/timed out/);
  });
  it('rejects challenges the server did not issue', async () => {
    const { svc } = build();
    const issued = challengesFor(NONCE, PEPPER);
    const wrong = ['blink_twice', 'turn_left', 'turn_right', 'smile'].filter((c) => !issued.includes(c as never)).slice(0, 2);
    await expect(svc.submit('u1', 'c1', await good({ challenges: wrong }))).rejects.toThrow(/liveness/);
  });
  it('rejects undecodable images (truncated JPEG stub) and duplicate frames', async () => {
    const { svc, storage } = build();
    const stub = img(Buffer.from([0xff, 0xd8, 0xff]));
    await expect(svc.submit('u1', 'c1', await good({ document: stub }))).rejects.toThrow(/could not be read/);
    const f = img(await jpeg(9));
    await expect(svc.submit('u1', 'c1', await good({ frames: [f, f, f] }))).rejects.toThrow(/different captures/);
    expect(storage.uploadPrivate).not.toHaveBeenCalled();
  });
  it('stores re-encoded JPEGs only (always .jpg), hash + duplicate flag set', async () => {
    const { svc, storage, state, users } = build({}, { users: (q) => (q.where.banned_at ? null : { id: 'someone' }) });
    await svc.submit('u1', 'c1', await good());
    expect(storage.uploadPrivate).toHaveBeenCalledTimes(4);
    expect(storage.uploadPrivate.mock.calls.every((c) => c[3] === 'image/jpeg')).toBe(true);
    expect(state.id_number_hash).toBe(hashIdNumber('HP0120190001', PEPPER));
    expect(state.duplicate_flag).toBe(true);
    expect(users.findOne).toHaveBeenCalled();
  });
  it('masked Aadhaar needs last4 + name and yields a comparable hash', async () => {
    const a = build();
    await expect(a.svc.submit('u1', 'c1', await good({ docType: 'aadhaar_masked', idNumber: undefined }))).rejects.toThrow(/last 4/);
    await expect(a.svc.submit('u1', 'c1', await good({ docType: 'aadhaar_masked', aadhaarLast4: '1234' }))).rejects.toThrow(/name/);
    await a.svc.submit('u1', 'c1', await good({ docType: 'aadhaar_masked', aadhaarLast4: '1234', nameOnId: 'Rohit  Kumar' }));
    const b = build();
    await b.svc.submit('u1', 'c1', await good({ docType: 'aadhaar_masked', aadhaarLast4: '1234', nameOnId: 'ROHIT KUMAR' }));
    expect(a.state.id_number_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.state.id_number_hash).toBe(b.state.id_number_hash);
  });
  it('blocks an ID held by a banned account without saying why', async () => {
    const { svc, storage } = build({}, { users: (q) => (q.where.banned_at ? { id: 'banned' } : null) });
    await expect(svc.submit('u1', 'c1', await good())).rejects.toBeInstanceOf(ForbiddenException);
    expect(storage.uploadPrivate).not.toHaveBeenCalled();
  });
});

describe('decisions', () => {
  it('approve verifies, keeps one selfie, records DOB/expiry ticks, notifies, purges', async () => {
    const { svc, em, storage, state, notifications, auditRows } = build(submitted);
    expect(await svc.approve('c1', 'admin', CHECKS)).toEqual({ success: true, purged: true });
    expect(storage.copy).toHaveBeenCalledWith('host-verification', 'b', 'host-selfies', 'u1/selfie.jpg');
    expect(em.update).toHaveBeenCalledWith(expect.anything(), { id: 'u1' }, expect.objectContaining({ is_id_verified: true, id_number_salted_hash: 'HASH' }));
    expect(state.doc_dob).toBe('1990-05-17');
    expect(state.adult_confirmed).toBe(true);
    expect(notifications.notify).toHaveBeenCalledWith('verification.approved', 'u1', expect.anything(), { dedupeKey: 'verification:c1:approved' });
    expect(auditRows.map((a) => a.action)).toEqual(['approved', 'purged']);
  });
  it('forbids approving or rejecting your own case', async () => {
    await expect(build(submitted).svc.approve('c1', 'u1', CHECKS)).rejects.toThrow(ForbiddenException);
    await expect(build(submitted).svc.reject('c1', 'u1', 'no good reason', false)).rejects.toThrow(ForbiddenException);
  });
  it('forbids a banned admin', async () => {
    const { svc } = build(submitted, { users: (q) => (q.where.id === 'admin' ? { id: 'admin', banned_at: new Date() } : null) });
    await expect(svc.approve('c1', 'admin', CHECKS)).rejects.toThrow(/cannot review/);
  });
  it('enforces age 18+, unexpired ID and the ticks', async () => {
    const mk = () => build(submitted).svc;
    const year = new Date().getUTCFullYear() - 10;
    await expect(mk().approve('c1', 'admin', { ...CHECKS, dateOfBirth: `${year}-01-01` })).rejects.toThrow(/at least 18/);
    await expect(mk().approve('c1', 'admin', { ...CHECKS, adultConfirmed: false })).rejects.toThrow(/18 or older/);
    await expect(mk().approve('c1', 'admin', { ...CHECKS, idExpiry: '2001-01-01' })).rejects.toThrow(/expired/);
    await expect(mk().approve('c1', 'admin', { ...CHECKS, notExpiredConfirmed: false })).rejects.toThrow(/not expired/);
    await expect(mk().approve('c1', 'admin', { ...CHECKS, dateOfBirth: '2020-02-31' })).rejects.toThrow(/valid date/);
  });
  it('masked Aadhaar needs no expiry', async () => {
    const { svc } = build({ ...submitted, doc_type: 'aadhaar_masked' });
    await expect(svc.approve('c1', 'admin', { dateOfBirth: '1990-05-17', adultConfirmed: true })).resolves.toMatchObject({ success: true });
  });
  it('409s when another account holds the ID, including the unique-index race (23505)', async () => {
    const a = build(submitted, { users: (q) => (q.where.id_number_salted_hash ? { id: 'other' } : null) });
    await expect(a.svc.approve('c1', 'admin', CHECKS)).rejects.toThrow(ConflictException);
    const b = build(submitted);
    b.dataSource.transaction.mockRejectedValue(uniqueErr);
    await expect(b.svc.approve('c1', 'admin', CHECKS)).rejects.toThrow(/Another account/);
  });
  it('stays approved but reports a failed purge', async () => {
    const { svc, storage, auditRows } = build(submitted);
    storage.remove.mockRejectedValue(new Error('boom'));
    expect(await svc.approve('c1', 'admin', CHECKS)).toEqual({ success: true, purged: false });
    expect(auditRows.map((a) => a.action)).toEqual(['approved', 'purge_failed']);
  });
  it('reject notifies with the reason; ban keeps the hash and sends nothing', async () => {
    const a = build(submitted);
    await a.svc.reject('c1', 'admin', 'Blurry ID photo', false);
    expect(a.notifications.notify).toHaveBeenCalledWith('verification.rejected', 'u1', expect.objectContaining({ reason: 'Blurry ID photo' }), { dedupeKey: 'verification:c1:rejected' });
    const b = build(submitted);
    await b.svc.reject('c1', 'admin', 'Photo does not match', true);
    expect(b.em.update).toHaveBeenCalledWith(expect.anything(), { id: 'u1' }, expect.objectContaining({ banned_at: expect.any(Date), id_number_salted_hash: 'HASH' }));
    expect(b.notifications.notify).not.toHaveBeenCalled();
  });
  it('second decision is a 409', async () => {
    const { svc } = build(submitted);
    await svc.approve('c1', 'admin', CHECKS);
    await expect(svc.reject('c1', 'admin', 'no good reason', false)).rejects.toThrow(ConflictException);
  });
});

describe('revoke', () => {
  it('resets the flag, audits and notifies; refuses self and unverified', async () => {
    const { svc, users, notifications, auditRows } = build({}, { users: (q) => (q.where.id === 'u1' ? { id: 'u1', is_id_verified: true } : null) });
    await svc.revoke('u1', 'admin', 'fake document found', false);
    expect(users.update).toHaveBeenCalledWith({ id: 'u1' }, expect.objectContaining({ is_id_verified: false, id_verified_at: null }));
    expect(auditRows.at(-1)?.action).toBe('revoked');
    expect(notifications.notify).toHaveBeenCalledWith('verification.revoked', 'u1', expect.anything(), expect.objectContaining({ dedupeKey: expect.stringContaining('verification:u1:revoked') }));
    await expect(svc.revoke('admin', 'admin', 'x'.repeat(6), false)).rejects.toThrow(ForbiddenException);
    const b = build({}, { users: (q) => (q.where.id === 'u1' ? { id: 'u1', is_id_verified: false } : null) });
    await expect(b.svc.revoke('u1', 'admin', 'x'.repeat(6), false)).rejects.toThrow(ConflictException);
  });
});

describe('queue', () => {
  it('paginates, escapes the search term, and computes SLA', async () => {
    const { svc, dataSource } = build();
    const old = new Date(Date.now() - 50 * 3600_000);
    dataSource.query.mockResolvedValue([{ id: 'c1', user_id: 'u1', status: 'submitted', submitted_at: old, attempts: '2', duplicate_flag: true, total: '23' }]);
    const res = await svc.listQueue({ q: '50%_x', page: 3, pageSize: 10 });
    expect(dataSource.query.mock.calls[0]![1]).toEqual(['submitted', '%50\\%\\_x%', 10, 20]);
    expect(res.total).toBe(23);
    expect(res.items[0]).toMatchObject({ attempts: 2, duplicateFlag: true, sla: 'overdue' });
  });
});

describe('sweep and face retries', () => {
  const qb = (rows: unknown[]) => () => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'where', 'andWhere', 'limit', 'orderBy']) q[m] = () => q;
    q.getRawMany = async () => [];
    q.getMany = async () => rows;
    return q;
  };
  it('expires stale cases, audits, and notifies the host', async () => {
    const { svc, cases, audits, notifications } = build({ status: 'submitted' });
    cases.find.mockResolvedValue([{ id: 'c1', user_id: 'u1', status: 'submitted' }]);
    (cases as Record<string, unknown>).createQueryBuilder = qb([]);
    expect(await svc.sweep()).toEqual({ expired: 1, purged: 0, rescored: 0 });
    expect(audits.save).toHaveBeenCalledWith(expect.objectContaining({ action: 'expired' }));
    expect(notifications.notify).toHaveBeenCalledWith('verification.expired', 'u1', expect.anything(), { dedupeKey: 'verification:c1:expired' });
  });
  it('re-scores cases stuck pending and gives up after the cap', async () => {
    const { svc, cases, face } = build(submitted);
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as never);
    (cases as Record<string, unknown>).createQueryBuilder = qb([
      { id: 'c1', user_id: 'u1', doc_path: 'd', liveness_paths: ['a', 'b', 'c'], face_attempts: 1 },
      { id: 'c2', user_id: 'u2', doc_path: 'd', liveness_paths: ['a'], face_attempts: 3 },
    ]);
    const res = await svc.sweep();
    expect(res.rescored).toBe(1);
    expect(face.score).toHaveBeenCalledTimes(1);
    expect(cases.update).toHaveBeenCalledWith({ id: 'c2', face_status: 'pending' }, { face_status: 'unavailable' });
    jest.restoreAllMocks();
  });
  it('admin rescore: 503 when no worker, 409 when not in queue', async () => {
    await expect(build(submitted, { faceConfigured: false }).svc.rescore('c1', 'admin')).rejects.toThrow(/not configured/);
    await expect(build({ status: 'approved' }).svc.rescore('c1', 'admin')).rejects.toThrow(ConflictException);
  });
  it('orphan sweep removes files for deleted users and purged cases only', async () => {
    const { svc, storage, users, cases } = build();
    const gone = '11111111-1111-1111-1111-111111111111';
    const kept = '22222222-2222-2222-2222-222222222222';
    const caseA = '33333333-3333-3333-3333-333333333333';
    const caseB = '44444444-4444-4444-4444-444444444444';
    storage.list.mockImplementation(async (_b: string, prefix: string) => {
      if (prefix === '') return [{ name: gone, isFolder: true }, { name: kept, isFolder: true }];
      if (prefix === gone) return [{ name: caseA, isFolder: true }];
      if (prefix === kept) return [{ name: caseA, isFolder: true }, { name: caseB, isFolder: true }];
      return [{ name: 'id.jpg', isFolder: false }];
    });
    users.find.mockResolvedValue([{ id: kept }]);
    cases.find.mockResolvedValue([{ id: caseB }]); // caseB still live, caseA purged/missing
    const res = await svc.sweepOrphanedFiles();
    expect(res.removed).toBe(2);
    expect(storage.remove).toHaveBeenCalledWith('host-verification', [`${gone}/${caseA}/id.jpg`]);
    expect(storage.remove).toHaveBeenCalledWith('host-verification', [`${kept}/${caseA}/id.jpg`]);
    expect(storage.remove).not.toHaveBeenCalledWith('host-verification', [`${kept}/${caseB}/id.jpg`]);
  });
});

describe('status', () => {
  it('reports banned, cooldown and attempts left', async () => {
    const { svc, users, cases } = build();
    users.findOne.mockResolvedValue({ id: 'u1', is_id_verified: false, banned_at: new Date() });
    cases.count.mockResolvedValue(2);
    const s = await svc.getMyStatus('u1');
    expect(s).toMatchObject({ banned: true, attemptsRemaining: 3 });
  });
});
