import Redis from 'ioredis';
import { Queue } from 'bullmq';

// Runs only when REDIS_URL is reachable; otherwise skipped.
const url = process.env.REDIS_URL;
let reachable = false;

beforeAll(async () => {
  if (!url) return;
  const r = new Redis(url, { lazyConnect: true, retryStrategy: () => null, connectTimeout: 2000 });
  r.on('error', () => undefined);
  try { await r.connect(); reachable = (await r.ping()) === 'PONG'; } catch { reachable = false; }
  r.disconnect();
});

it('dedupes jobs with the same jobId on a real Redis', async () => {
  if (!reachable) return console.warn('skipped: Redis not reachable');
  const conn = new Redis(url!, { maxRetriesPerRequest: null });
  const q = new Queue(`itest-${Date.now()}`, { connection: conn });
  try {
    await q.add('j', {}, { jobId: 'same' });
    await q.add('j', {}, { jobId: 'same' });
    expect(await q.getJobCounts('waiting')).toEqual({ waiting: 1 });
  } finally {
    await q.obliterate({ force: true });
    await q.close();
    conn.disconnect();
  }
});
