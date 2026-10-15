import { HttpException } from '@nestjs/common';
import { isTransientDbError, Semaphore, withTimeout, withTransientRetry } from './db-resilience';

describe('isTransientDbError', () => {
  it.each(['57P01', '57P03', '08006', '08003', '08000', 'ECONNRESET'])('treats code %s as transient', (code) => {
    expect(isTransientDbError({ code })).toBe(true);
  });
  it('matches pg connection messages', () => {
    expect(isTransientDbError(new Error('Connection terminated due to connection timeout'))).toBe(true);
    expect(isTransientDbError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientDbError(new Error('timeout exceeded when trying to connect'))).toBe(true);
  });
  it('sees through a TypeORM wrapper', () => {
    expect(isTransientDbError({ message: 'query failed', driverError: { code: '57P01' } })).toBe(true);
  });
  it('rejects query errors', () => {
    expect(isTransientDbError(new Error('syntax error at or near'))).toBe(false);
    expect(isTransientDbError({ code: '23505' })).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
  });
});

describe('withTransientRetry', () => {
  it('retries once on a transient error', async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error('Connection terminated')).mockResolvedValue('ok');
    await expect(withTransientRetry(fn, 1)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('does not retry a non-transient error', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('syntax error'));
    await expect(withTransientRetry(fn, 1)).rejects.toThrow('syntax error');
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('gives up after one retry', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('Connection terminated'));
    await expect(withTransientRetry(fn, 1)).rejects.toThrow('Connection terminated');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('Semaphore', () => {
  it('never runs more than the limit at once and queues the rest', async () => {
    const sem = new Semaphore(2, 1000);
    let active = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      });
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBe(2);
  });
  it('rejects a waiter with a 503 after the max wait', async () => {
    const sem = new Semaphore(1, 20);
    const holder = sem.run(() => new Promise((r) => setTimeout(r, 100)));
    const err = await sem.run(async () => 1).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(503);
    await holder;
    await expect(sem.run(async () => 'free')).resolves.toBe('free');
  });
  it('releases the slot when the task throws', async () => {
    const sem = new Semaphore(1, 50);
    await expect(sem.run(async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('withTimeout', () => {
  it('returns the fallback when the promise hangs', async () => {
    await expect(withTimeout(new Promise<string | null>(() => {}), 10, null)).resolves.toBeNull();
  });
  it('returns the value when fast', async () => {
    await expect(withTimeout(Promise.resolve('v'), 50, null)).resolves.toBe('v');
  });
});
