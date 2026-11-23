import { QueueService } from './queue.service';
import { ExampleProcessor } from './example.processor';
import { workersEnabled, workerProviders } from './queue.constants';

const fakeQueue = () => ({ add: jest.fn(async (n, d, o) => ({ name: n, data: d, opts: o })), on: jest.fn(), close: jest.fn(), getJobCounts: jest.fn(async () => ({ waiting: 1 })) });

function make(redis: any = { ping: async () => 'PONG', quit: jest.fn() }) {
  const q = Array.from({ length: 5 }, fakeQueue);
  const svc = new QueueService(q[0] as any, q[1] as any, q[2] as any, q[3] as any, q[4] as any, redis);
  return { svc, q };
}

describe('QueueService', () => {
  it('uses the idempotency key as jobId (colons sanitised)', async () => {
    const { svc, q } = make();
    await svc.enqueue('notifications', 'send', { a: 1 }, { idempotencyKey: 'booking:42:confirmed', delay: 5 });
    expect(q[0].add).toHaveBeenCalledWith('send', { a: 1 }, { delay: 5, jobId: 'booking_42_confirmed' });
  });

  it('throws a clear error when REDIS_URL is not configured', async () => {
    const { svc } = make(null);
    await expect(svc.enqueue('outreach', 'x', {})).rejects.toThrow(/REDIS_URL/);
    expect((await svc.health()).redis).toBe('unconfigured');
  });

  it('reports health with counts, and down when ping fails', async () => {
    expect((await make().svc.health()).queues.notifications).toEqual({ waiting: 1 });
    const h = await make({ ping: async () => { throw new Error('nope'); }, quit: jest.fn() }).svc.health();
    expect(h).toMatchObject({ ok: false, redis: 'down' });
  });

  it('dead-letters a job with a deterministic id', async () => {
    const { svc, q } = make();
    await svc.deadLetter('automation', { id: '9', name: 'j', data: { z: 1 }, attemptsMade: 5, opts: { attempts: 5 } } as any, new Error('bad'));
    expect(q[4].add.mock.calls[0][2]).toMatchObject({ jobId: 'dl-automation-9', attempts: 1 });
    expect(QueueService.isFinalFailure({ attemptsMade: 5, opts: { attempts: 5 } } as any)).toBe(true);
    expect(QueueService.isFinalFailure({ attemptsMade: 2, opts: { attempts: 5 } } as any)).toBe(false);
  });

  it('worker mode switch', () => {
    expect(workersEnabled({ QUEUE_WORKERS: 'true' })).toBe(true);
    expect(workersEnabled({})).toBe(false);
    expect(workerProviders(ExampleProcessor)).toEqual([]);
  });

  it('example processor handles a job and dead-letters on final failure', async () => {
    const dl = jest.fn();
    const p = new ExampleProcessor({ deadLetter: dl } as any);
    expect(await p.process({ name: 'example.ping', data: { n: 2 } } as any)).toEqual({ doubled: 4 });
    await expect(p.process({ name: 'other', data: {} } as any)).rejects.toThrow();
    await p.onFailed({ id: '1', attemptsMade: 5, opts: { attempts: 5 } } as any, new Error('e'));
    expect(dl).toHaveBeenCalled();
  });
});
