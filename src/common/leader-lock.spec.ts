import { LockBackend, PgAdvisoryLockBackend, RedisLockBackend, runExclusive, setLockBackends } from './leader-lock';

class FakeRedis {
  store = new Map<string, string>();
  fail = false;
  async set(k: string, v: string, _px: string, _ttl: number, _nx: string) {
    if (this.fail) throw new Error('down');
    if (this.store.has(k)) return null;
    this.store.set(k, v);
    return 'OK';
  }
  async eval(_s: string, _n: number, k: string, token: string) {
    if (this.store.get(k) === token) this.store.delete(k);
    return 1;
  }
}

describe('runExclusive', () => {
  afterEach(() => setLockBackends(undefined));

  it('only one concurrent caller wins and the lock is released afterwards', async () => {
    const redis = new FakeRedis();
    setLockBackends([new RedisLockBackend(redis as any)]);
    const fn = jest.fn(() => new Promise<string>((r) => setTimeout(() => r('x'), 20)));
    const [a, b] = await Promise.all([runExclusive('k', 1000, fn), runExclusive('k', 1000, fn)]);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect((await runExclusive('k', 1000, async () => 1)).ran).toBe(true);
  });

  it('releases the lock when fn throws', async () => {
    setLockBackends([new RedisLockBackend(new FakeRedis() as any)]);
    await expect(runExclusive('k', 1000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect((await runExclusive('k', 1000, async () => 1)).ran).toBe(true);
  });

  it('falls back to the next backend when redis fails', async () => {
    const r = new FakeRedis();
    r.fail = true;
    const pgBackend: LockBackend = { acquire: jest.fn(async () => async () => undefined) };
    setLockBackends([new RedisLockBackend(r as any), pgBackend]);
    expect((await runExclusive('k', 1000, async () => 1)).ran).toBe(true);
    expect(pgBackend.acquire).toHaveBeenCalled();
  });

  it('runs unlocked (fail-open) when no backend works', async () => {
    setLockBackends([]);
    expect(await runExclusive('k', 1000, async () => 7)).toEqual({ ran: true, result: 7 });
  });

  it('pg backend: skips when advisory lock is held, unlocks when acquired', async () => {
    const q = jest.fn().mockResolvedValueOnce({ rows: [{ got: false }] });
    const end = jest.fn().mockResolvedValue(undefined);
    expect(await new PgAdvisoryLockBackend(async () => ({ query: q, end }) as any).acquire('k')).toBeNull();
    expect(end).toHaveBeenCalled();
    const q2 = jest.fn().mockResolvedValueOnce({ rows: [{ got: true }] }).mockResolvedValue({ rows: [] });
    const rel = await new PgAdvisoryLockBackend(async () => ({ query: q2, end }) as any).acquire('k');
    await rel!();
    expect(q2.mock.calls[1][0]).toContain('pg_advisory_unlock');
  });
});
