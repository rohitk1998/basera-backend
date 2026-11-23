import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { Client } from 'pg';

const logger = new Logger('LeaderLock');
const PREFIX = 'RhenBasera:lock:';
const RELEASE = `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`;

/** Minimal backend contract so tests can inject fakes. acquire returns a release fn, or null if held elsewhere. */
export interface LockBackend {
  acquire(key: string, ttlMs: number): Promise<(() => Promise<void>) | null>;
}

export class RedisLockBackend implements LockBackend {
  constructor(private readonly redis: Pick<Redis, 'set' | 'eval'>) {}
  async acquire(key: string, ttlMs: number) {
    const token = randomUUID();
    const ok = await this.redis.set(PREFIX + key, token, 'PX', ttlMs, 'NX');
    if (ok !== 'OK') return null;
    return async () => {
      await this.redis.eval(RELEASE, 1, PREFIX + key, token).catch(() => undefined);
    };
  }
}

/** Session-level pg_try_advisory_lock on a dedicated connection held for the duration of fn. */
export class PgAdvisoryLockBackend implements LockBackend {
  constructor(private readonly connect: () => Promise<Pick<Client, 'query' | 'end'>>) {}
  async acquire(key: string) {
    const client = await this.connect();
    try {
      const r = await client.query('select pg_try_advisory_lock(hashtext($1)::bigint) as got', [key]);
      if (!r.rows[0]?.got) {
        await client.end();
        return null;
      }
    } catch (e) {
      await client.end().catch(() => undefined);
      throw e;
    }
    return async () => {
      await client.query('select pg_advisory_unlock(hashtext($1)::bigint)', [key]).catch(() => undefined);
      await client.end().catch(() => undefined);
    };
  }
}

let backends: LockBackend[] | undefined;
let redisClient: Redis | undefined;

function defaultBackends(): LockBackend[] {
  const list: LockBackend[] = [];
  const url = process.env.REDIS_URL;
  if (url) {
    redisClient ??= new Redis(url, { maxRetriesPerRequest: 1, commandTimeout: 2_500, connectTimeout: 5_000, enableOfflineQueue: false, lazyConnect: false });
    redisClient.on('error', () => undefined);
    list.push(new RedisLockBackend(redisClient));
  }
  const host = process.env.SUPABASE_DB_HOST;
  if (host) {
    list.push(
      new PgAdvisoryLockBackend(async () => {
        const c = new Client({
          host,
          port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
          user: process.env.SUPABASE_DB_USER,
          password: process.env.SUPABASE_DB_PASSWORD,
          database: process.env.SUPABASE_DB_NAME,
          ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
          connectionTimeoutMillis: 5_000,
        });
        await c.connect();
        return c;
      }),
    );
  }
  return list;
}

/** Test hook. Pass undefined to restore env-derived defaults. */
export function setLockBackends(b: LockBackend[] | undefined): void {
  backends = b;
}

/**
 * Run fn only if this replica wins the lock for `key` (Redis SET NX PX first, Postgres advisory lock fallback).
 * Returns { ran:false } when another replica holds it. If NO backend is reachable the job runs anyway
 * (fail-open, with a warning): every wrapped job is idempotent, and a skipped tick is worse than a duplicate one.
 * ttlMs must exceed the job's worst-case duration; the Redis lock expires on its own if a replica dies.
 */
export async function runExclusive<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
  let release: (() => Promise<void>) | null | undefined;
  for (const b of (backends ??= defaultBackends())) {
    try {
      release = await b.acquire(key, ttlMs);
      if (release === null) return { ran: false };
      break;
    } catch (e: any) {
      logger.warn(`lock backend failed for ${key}: ${e?.message ?? e}`);
    }
  }
  if (release === undefined) logger.warn(`no lock backend available for ${key}; running unlocked`);
  try {
    return { ran: true, result: await fn() };
  } finally {
    await release?.().catch(() => undefined);
  }
}
