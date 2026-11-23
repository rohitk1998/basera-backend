import { JobRouter, JobTimeoutError, UnknownJobError } from './job-router';
import { QueueJobRegistry } from './queue-job-registry';

const job = (name: string, extra: Record<string, unknown> = {}) => ({ id: '1', name, data: {}, attemptsMade: 0, opts: { attempts: 3 }, ...extra }) as any;
const makeLog = () => ({ started: jest.fn(async () => undefined), completed: jest.fn(async () => undefined), failed: jest.fn(async () => undefined) });

describe('JobRouter', () => {
  it('dispatches by queue + job name and logs start/finish', async () => {
    const reg = new QueueJobRegistry();
    const a = jest.fn(async () => ({ ok: 'a' }));
    const b = jest.fn(async () => ({ ok: 'b' }));
    reg.register('automation', 'a.job', a);
    reg.register('automation', 'b.job', b);
    reg.register('outreach', 'a.job', b); // same name, other queue
    const log = makeLog();
    const router = new JobRouter(reg, log as any);
    expect(await router.dispatch('automation', job('a.job'))).toEqual({ ok: 'a' });
    expect(b).not.toHaveBeenCalled();
    expect(log.started).toHaveBeenCalledWith('automation', '1', 'a.job', 1);
    expect(log.completed).toHaveBeenCalledWith('automation', '1');
  });

  it('FAILS on an unknown job name instead of silently completing', async () => {
    const reg = new QueueJobRegistry();
    const log = makeLog();
    const router = new JobRouter(reg, log as any);
    await expect(router.dispatch('automation', job('nobody.handles.this'))).rejects.toBeInstanceOf(UnknownJobError);
    expect(log.started).toHaveBeenCalled(); // visible in jobs_log
    expect(log.completed).not.toHaveBeenCalled();
  });

  it('rejects duplicate registration', () => {
    const reg = new QueueJobRegistry();
    reg.register('automation', 'x', () => 1);
    expect(() => reg.register('automation', 'x', () => 2)).toThrow(/already registered/);
  });

  it('times out a slow handler', async () => {
    const reg = new QueueJobRegistry();
    reg.register('automation', 'slow', () => new Promise(() => undefined), { timeoutMs: 20 });
    await expect(new JobRouter(reg, makeLog() as any).dispatch('automation', job('slow'))).rejects.toBeInstanceOf(JobTimeoutError);
  });

  it('enforces per-job concurrency', async () => {
    const reg = new QueueJobRegistry();
    let running = 0; let peak = 0;
    reg.register('automation', 'c', async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 15)); running--; }, { concurrency: 2 });
    const router = new JobRouter(reg, makeLog() as any);
    await Promise.all([1, 2, 3, 4, 5].map((i) => router.dispatch('automation', job('c', { id: String(i) }))));
    expect(peak).toBe(2);
  });

  it('records failures and dead-letters only on the final attempt', async () => {
    const dl = jest.fn(async () => undefined);
    const log = makeLog();
    const router = new JobRouter(new QueueJobRegistry(), log as any, { deadLetter: dl } as any);
    await router.onFailed('automation', job('x', { attemptsMade: 1 }), new Error('boom'));
    expect(log.failed).toHaveBeenLastCalledWith('automation', '1', 'x', 1, 'boom', false);
    expect(dl).not.toHaveBeenCalled();
    await router.onFailed('automation', job('x', { attemptsMade: 3 }), new Error('boom'));
    expect(log.failed).toHaveBeenLastCalledWith('automation', '1', 'x', 3, 'boom', true);
    expect(dl).toHaveBeenCalledTimes(1);
  });
});
