import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Shared Redis client (the `flashpay_redis` container — this instance is
 * not Basera-dedicated, so every key this service touches is namespaced
 * under `basera:` to avoid colliding with or being flushed alongside
 * another project's data).
 *
 * Every method degrades to a no-op/miss on connection failure rather than
 * throwing — Redis here is a read-through speed layer in front of
 * Postgres, never the source of truth, so callers always have a working
 * fallback (the DB query they'd have made anyway).
 */
/** Long enough for a slow cross-region round trip, short enough that a dead
 *  connection costs a request seconds, not its whole life. */
const REDIS_COMMAND_TIMEOUT_MS = 2_500;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  readonly keyPrefix = 'basera:';

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    this.client = new Redis(url, {
      keyPrefix: this.keyPrefix,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 200, 2000),
      // A connection that has silently died (a dropped laptop network, a NAT
      // that forgot the idle socket) never errors: commands are written to it
      // and simply wait. Without these two settings every request that
      // touches the cache hangs with it, forever, instead of falling back to
      // the database as this class promises.
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
      keepAlive: 10_000,
      connectTimeout: 5_000,
    });
    this.client.on('error', (err) => this.logger.warn(`Redis connection error: ${err.message}`));
  }

  /** A timed-out command means the socket is probably dead, so drop it and
   *  let ioredis open a fresh one rather than timing out on it again. */
  private recoverFromTimeout(err: any): void {
    if (!String(err?.message ?? '').includes('timed out')) return;
    this.logger.warn('Redis command timed out — reconnecting');
    // A polite close waits for the other end to answer, which a dead
    // connection never does. Destroying the socket makes ioredis notice at
    // once and open a new one through its normal retry path.
    if (this.client.stream && !this.client.stream.destroyed) this.client.stream.destroy();
    else this.client.disconnect(true);
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (err: any) {
      this.logger.warn(`GET ${key} failed: ${err?.message ?? err}`);
      this.recoverFromTimeout(err);
      return null;
    }
  }

  /** Resolves true when the value was stored, false when it could not be —
   *  callers that only use Redis as a cache can ignore it; a caller that
   *  needs the value to be there later (a one-time token) must not. */
  async set(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      await this.client.set(key, value, 'EX', ttlSeconds);
      return true;
    } catch (err: any) {
      this.logger.warn(`SET ${key} failed: ${err?.message ?? err}`);
      this.recoverFromTimeout(err);
      return false;
    }
  }

  /** Explicit invalidation for write-sensitive caches (unlike the
   *  content-hash-keyed translation cache, which never needs one — the key
   *  itself changes when content does). Safe no-op on failure, same as
   *  every other method here: a key that fails to delete just serves stale
   *  data until its TTL expires, not an error the caller has to handle. */
  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err: any) {
      this.logger.warn(`DEL ${key} failed: ${err?.message ?? err}`);
      this.recoverFromTimeout(err);
    }
  }

  /** Monotonic counter, namespaced like every other key. Used as a cache
   *  "generation" tag: bumping it invalidates every previously-cached key
   *  that embeds the old value, without a KEYS/SCAN sweep (unsafe against a
   *  shared, non-Basera-dedicated Redis instance — see the class doc) and
   *  without tracking which exact keys exist. Returns 1 on the very first
   *  call for a given name (ioredis INCR on a missing key starts at 0, so
   *  the returned post-increment value is 1). Falls back to a fresh
   *  Date.now() on failure — still safe: it just makes every embedding key
   *  compute to a value no earlier caller could have cached under. */
  async incrementVersion(name: string): Promise<number> {
    try {
      return await this.client.incr(name);
    } catch (err: any) {
      this.logger.warn(`INCR ${name} failed: ${err?.message ?? err}`);
      this.recoverFromTimeout(err);
      return Date.now();
    }
  }

  /** Current value of a version counter (see incrementVersion), or '0' if
   *  it has never been bumped — used to build a cache key that a later
   *  incrementVersion() call will stop matching. */
  async getVersion(name: string): Promise<string> {
    try {
      return (await this.client.get(name)) ?? '0';
    } catch (err: any) {
      this.logger.warn(`GET ${name} failed: ${err?.message ?? err}`);
      this.recoverFromTimeout(err);
      return String(Date.now());
    }
  }

  async onModuleDestroy() {
    await this.client.quit().catch(() => {});
  }
}
