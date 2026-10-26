import { HttpException, HttpStatus } from '@nestjs/common';

const TRANSIENT_PG_CODES = new Set(['57P01', '57P03', '08006', '08003', '08000']);
const TRANSIENT_MESSAGES = ['Connection terminated', 'timeout exceeded when trying to connect'];

export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const e = err as { code?: unknown; message?: unknown; driverError?: unknown };
  if (typeof e.code === 'string' && (TRANSIENT_PG_CODES.has(e.code) || e.code === 'ECONNRESET')) return true;
  const message = typeof e.message === 'string' ? e.message : '';
  if (TRANSIENT_MESSAGES.some((m) => message.includes(m))) return true;
  return e.driverError !== undefined && e.driverError !== err && isTransientDbError(e.driverError);
}

export async function withTransientRetry<T>(fn: () => Promise<T>, backoffMs = 150): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientDbError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    return fn();
  }
}

export class ServiceBusyException extends HttpException {
  constructor(retryAfterSeconds = 2) {
    super(
      { message: 'The server is busy. Please try again in a moment.', retryAfterSeconds },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number, private readonly maxWaitMs: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new ServiceBusyException());
      }, this.maxWaitMs);
      this.waiters.push(grant);
    });
  }

  private release(): void {
    const next = this.waiters.shift();

    if (next) next();
    else this.active--;
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
