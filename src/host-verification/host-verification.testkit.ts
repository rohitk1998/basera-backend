import { HostVerificationService } from './host-verification.service';
import { challengesFor, issueLivenessToken } from './liveness-token.util';

export const PEPPER = 'k'.repeat(40);
export const NONCE = 'a'.repeat(32);

/** A synthetic 'JPEG' (valid magic bytes); `seed` makes each byte-different. Decoding is stubbed in the service spec. */
export async function jpeg(seed = 0): Promise<Buffer> {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, seed, seed + 1, seed + 2, 0x10, 0x20, 0x30]);
}
export const img = (b: Buffer) => ({ buffer: b, size: b.length });

export function build(
  caseOver: Record<string, unknown> = {},
  opts: { cfg?: Record<string, string | undefined>; faceConfigured?: boolean; users?: (q: { where: Record<string, unknown> }) => unknown } = {},
) {
  const cfg = opts.cfg ?? { ID_HASH_PEPPER: PEPPER };
  const state: Record<string, unknown> = {
    id: 'c1', user_id: 'u1', status: 'consented', doc_type: null, id_number_hash: null,
    doc_path: null, liveness_paths: null, face_score: null, face_status: 'pending', face_attempts: 1,
    liveness_nonce: NONCE, expires_at: new Date(Date.now() + 1e9), ...caseOver,
  };
  const cases = {
    findOne: jest.fn().mockImplementation(async () => ({ ...state })),
    update: jest.fn().mockImplementation(async (w: { status?: unknown }, p: Record<string, unknown>) => {
      if (typeof w.status === 'string' && w.status !== state.status) return { affected: 0 };
      Object.assign(state, p);
      return { affected: 1 };
    }),
    insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'new-case' }] }),
    count: jest.fn().mockResolvedValue(0),
    increment: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(),
  };
  const users = { findOne: jest.fn().mockImplementation(async (q: { where: Record<string, unknown> }) => (opts.users ? opts.users(q) : null)), update: jest.fn().mockResolvedValue({ affected: 1 }), find: jest.fn().mockResolvedValue([]) };
  const auditRows: Array<{ action: string; meta: Record<string, unknown> }> = [];
  const audits = { create: (r: never) => r, save: jest.fn().mockImplementation(async (r) => auditRows.push(r)) };
  const em = {
    update: jest.fn().mockImplementation(async (ent: { name?: string }, w: { status?: string }, p: Record<string, unknown>) => {
      if (ent?.name === 'HostVerificationCaseEntity') {
        if (w.status && w.status !== state.status) return { affected: 0 };
        Object.assign(state, p);
      }
      return { affected: 1 };
    }),
  };
  const dataSource = { transaction: jest.fn().mockImplementation(async (fn: (e: typeof em) => unknown) => fn(em)), query: jest.fn() };
  const storage = {
    uploadPrivate: jest.fn().mockResolvedValue(undefined), copy: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined), createSignedDownloadUrl: jest.fn().mockResolvedValue('https://signed'),
    list: jest.fn().mockResolvedValue([]),
  };
  const face = { score: jest.fn().mockResolvedValue({ status: 'scored', score: 0.7 }), isConfigured: jest.fn().mockReturnValue(opts.faceConfigured ?? true) };
  const notifications = { notify: jest.fn() };
  const svc = new HostVerificationService(
    cases as never, users as never, audits as never, dataSource as never, storage as never, face as never,
    { get: (k: string) => cfg[k] } as never, notifications as never,
  );
  return { svc, cases, users, em, storage, face, state, audits, auditRows, notifications, dataSource };
}

/** A valid submission for the default case (nonce, challenges and token are all server-consistent). */
export async function good(over: Record<string, unknown> = {}, caseId = 'c1', userId = 'u1') {
  const challenges = [...challengesFor(NONCE, PEPPER)];
  return {
    docType: 'driving_license',
    idNumber: 'HP-01 2019 0001',
    livenessToken: issueLivenessToken(caseId, userId, NONCE, Date.now() + 60_000, PEPPER),
    challenges,
    document: img(await jpeg(1)),
    frames: [img(await jpeg(2)), img(await jpeg(3)), img(await jpeg(4))],
    ...over,
  };
}

export const CHECKS = { dateOfBirth: '1990-05-17', idExpiry: '2099-01-01', adultConfirmed: true, notExpiredConfirmed: true };
