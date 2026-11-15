import { ConflictException, ForbiddenException } from '@nestjs/common';
import { HostVerificationService } from './host-verification.service';

const PEPPER = 'x'.repeat(40);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const img = (b = JPEG) => ({ buffer: b, size: b.length });

function build(overrides: { removeFails?: boolean; bannedHash?: boolean; otherHolder?: boolean } = {}) {
  const base = {
    id: 'case1', user_id: 'u1', status: 'submitted', doc_type: 'driving_license',
    id_number_hash: 'HASH', doc_path: 'u1/case1/id.jpg',
    liveness_paths: ['u1/case1/frame-1.jpg', 'u1/case1/frame-2.jpg', 'u1/case1/frame-3.jpg'],
    face_score: 0.8, expires_at: new Date(Date.now() + 1e9),
  };
  const state = { ...base } as Record<string, unknown>;
  const cases = {
    findOne: jest.fn().mockImplementation(async () => ({ ...state })),
    update: jest.fn().mockImplementation(async (_w: unknown, patch: Record<string, unknown>) => {
      Object.assign(state, patch);
      return { affected: 1 };
    }),
    insert: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(),
  };
  const users = {
    findOne: jest.fn().mockImplementation(async (q: { where: Record<string, unknown> }) => {
      if (q.where.banned_at && overrides.bannedHash) return { id: 'banned' };
      if (q.where.id_number_salted_hash && !q.where.banned_at && overrides.otherHolder) return { id: 'other' };
      return null;
    }),
  };
  const auditRows: Array<{ action: string; meta: Record<string, unknown> }> = [];
  const audits = { create: (r: never) => r, save: jest.fn().mockImplementation(async (r) => auditRows.push(r)) };
  const em = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const dataSource = { transaction: jest.fn().mockImplementation(async (fn: (e: typeof em) => unknown) => fn(em)), query: jest.fn() };
  const storage = {
    uploadPrivate: jest.fn().mockResolvedValue(undefined),
    copy: jest.fn().mockResolvedValue(undefined),
    remove: overrides.removeFails ? jest.fn().mockRejectedValue(new Error('boom')) : jest.fn().mockResolvedValue(undefined),
    createSignedDownloadUrl: jest.fn().mockResolvedValue('https://signed'),
  };
  const face = { score: jest.fn().mockResolvedValue({ status: 'scored', score: 0.7 }) };
  const config = { get: (k: string) => (k === 'ID_HASH_PEPPER' ? PEPPER : undefined) };
  const service = new HostVerificationService(
    cases as never, users as never, audits as never, dataSource as never, storage as never, face as never, config as never,
  );
  return { service, cases, users, em, storage, auditRows, state };
}

describe('HostVerificationService.approve', () => {
  it('verifies the host, keeps one selfie, then hard-deletes the raw files', async () => {
    const { service, em, storage, state, auditRows } = build();
    const res = await service.approve('case1', 'admin1');

    expect(res).toEqual({ success: true, purged: true });
    expect(storage.copy).toHaveBeenCalledWith('host-verification', 'u1/case1/frame-2.jpg', 'host-selfies', 'u1/selfie.jpg');
    expect(em.update).toHaveBeenCalledWith(expect.anything(), { id: 'u1' }, expect.objectContaining({
      is_id_verified: true, id_number_salted_hash: 'HASH', selfie_url: 'u1/selfie.jpg',
    }));
    expect(storage.remove).toHaveBeenCalledWith('host-verification', [
      'u1/case1/id.jpg', 'u1/case1/frame-1.jpg', 'u1/case1/frame-2.jpg', 'u1/case1/frame-3.jpg',
    ]);
    expect(state.doc_path).toBeNull();
    expect(state.liveness_paths).toBeNull();
    expect(state.id_number_hash).toBeNull();
    expect(auditRows.map((a) => a.action)).toEqual(['approved', 'purged']);
  });

  it('stays approved but reports a failed purge, and audits it for retry', async () => {
    const { service, auditRows, state } = build({ removeFails: true });
    const res = await service.approve('case1', 'admin1');

    expect(res).toEqual({ success: true, purged: false });
    expect(auditRows.map((a) => a.action)).toEqual(['approved', 'purge_failed']);
    expect(state.doc_path).toBe('u1/case1/id.jpg');
  });

  it('refuses when another account already holds this ID', async () => {
    const { service, em } = build({ otherHolder: true });
    await expect(service.approve('case1', 'admin1')).rejects.toBeInstanceOf(ConflictException);
    expect(em.update).not.toHaveBeenCalled();
  });
});

describe('HostVerificationService.reject', () => {
  it('ban keeps the ID hash on the banned user and still purges the files', async () => {
    const { service, em, storage } = build();
    await service.reject('case1', 'admin1', 'Photo does not match', true);

    expect(em.update).toHaveBeenCalledWith(expect.anything(), { id: 'u1' }, expect.objectContaining({
      banned_at: expect.any(Date), id_number_salted_hash: 'HASH',
    }));
    expect(storage.remove).toHaveBeenCalled();
  });

  it('a plain rejection does not touch the user row', async () => {
    const { service, em } = build();
    await service.reject('case1', 'admin1', 'Blurry ID photo', false);
    const userUpdates = em.update.mock.calls.filter((c) => (c[1] as { id?: string }).id === 'u1');
    expect(userUpdates).toHaveLength(0);
  });
});

describe('HostVerificationService.submit guards', () => {
  const consented = { status: 'consented' };
  const input = (over: Record<string, unknown> = {}) => ({
    docType: 'driving_license', idNumber: 'DL0120190001', challenges: ['blink_twice', 'smile'],
    document: img(), frames: [img(), img(), img()], ...over,
  });

  it('never accepts a typed Aadhaar number', async () => {
    const { service, storage, state } = build();
    Object.assign(state, consented);
    await expect(service.submit('u1', 'case1', input({ idNumber: '1234 5678 9012' }))).rejects.toThrow(/Aadhaar/);
    expect(storage.uploadPrivate).not.toHaveBeenCalled();
  });

  it('blocks an ID whose hash belongs to a banned account, without revealing why', async () => {
    const { service, storage, state } = build({ bannedHash: true });
    Object.assign(state, consented);
    await expect(service.submit('u1', 'case1', input())).rejects.toBeInstanceOf(ForbiddenException);
    expect(storage.uploadPrivate).not.toHaveBeenCalled();
  });

  it('rejects a non-image upload before anything is stored', async () => {
    const { service, storage, state } = build();
    Object.assign(state, consented);
    const fake = img(Buffer.from('<svg/>'));
    await expect(service.submit('u1', 'case1', input({ document: fake }))).rejects.toThrow(/JPEG or PNG/);
    expect(storage.uploadPrivate).not.toHaveBeenCalled();
  });

  it('requires exactly two distinct challenges and three frames', async () => {
    const { service, state } = build();
    Object.assign(state, consented);
    await expect(service.submit('u1', 'case1', input({ challenges: ['smile', 'smile'] }))).rejects.toThrow(/liveness/);
    await expect(service.submit('u1', 'case1', input({ frames: [img()] }))).rejects.toThrow(/3 live frames/);
  });

  it('stores a valid submission and queues it', async () => {
    const { service, storage, state, cases } = build();
    Object.assign(state, consented);
    const res = await service.submit('u1', 'case1', input());
    expect(res).toEqual({ success: true, status: 'submitted' });
    expect(storage.uploadPrivate).toHaveBeenCalledTimes(4);
    expect(cases.update).toHaveBeenCalledWith({ id: 'case1', status: 'consented' }, expect.objectContaining({ status: 'submitted' }));
  });
});
