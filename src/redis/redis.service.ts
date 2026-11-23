import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const REDIS_COMMAND_TIMEOUT_MS = 2_500;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  readonly keyPrefix = 'RhenBasera:';

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    this.client = new Redis(url, {
      keyPrefix: this.keyPrefix,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 200, 2000),
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
      keepAlive: 10_000,
      connectTimeout: 5_000,
    });
    this.client.on('error', (err) => this.logger.warn(`Redis connection error: ${err.message}`));
  }

  private recoverFromTimeout(err: any): void {
    if (!String(err?.message ?? '').includes('timed out')) return;
    this.logger.warn('Redis command timed out — reconnecting');
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

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err: any) {
      this.logger.warn(`DEL ${key} failed: ${err?.message ?? err}`);
      this.recoverFromTimeout(err);
    }
  }

  async pushToList(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      await this.client.multi().rpush(key, value).expire(key, ttlSeconds).exec();
      return true;
    } catch (err: any) {
      this.logger.warn(`RPUSH ${key} failed: ${err?.message ?? err}`);
      this.recoverFromTimeout(err);
      return false;
    }
  }

  async getList(key: string): Promise<string[]> {
    try {
      return await this.client.lrange(key, 0, -1);
    } catch (err: any) {
      this.logger.warn(`LRANGE ${key} failed: ${err?.message ?? err}`);
      this.recoverFromTimeout(err);
      return [];
    }
  }

  /**
   * Atomic "count one, but only while the total stays within `limit`". One Lua call, so concurrent workers
   * (several API instances) can never overshoot. Fails CLOSED (false) when Redis is unreachable: this guards paid calls.
   */
  async incrWithin(key: string, limit: number, ttlSeconds: number): Promise<boolean> {
    try {
      const r = await this.client.eval(
        `local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end if n > tonumber(ARGV[1]) then redis.call('DECR', KEYS[1]) return 0 end return 1`,
        1, key, limit, ttlSeconds,
      );
      return Number(r) === 1;
    } catch (err: any) {
      this.logger.warn(`incrWithin ${key} failed: ${err?.message ?? err}`);
      this.recoverFromTimeout(err);
      return false;
    }
  }

  /** Plain counter +1 with a TTL (set on first increment). Best effort: never throws. */
  async bump(key: string, ttlSeconds: number): Promise<void> {
    try {
      const n = await this.client.incr(key);
      if (n === 1) await this.client.expire(key, ttlSeconds);
    } catch (err: any) {
      this.logger.warn(`bump ${key} failed: ${err?.message ?? err}`);
      this.recoverFromTimeout(err);
    }
  }

  /** Several string keys in one round trip; missing/unreachable -> null. */
  async mget(keys: string[]): Promise<(string | null)[]> {
    if (!keys.length) return [];
    try {
      return await this.client.mget(...keys);
    } catch (err: any) {
      this.logger.warn(`MGET failed: ${err?.message ?? err}`);
      this.recoverFromTimeout(err);
      return keys.map(() => null);
    }
  }

  /** Add to a set with a TTL, and read it back. */
  async addToSet(key: string, member: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.multi().sadd(key, member).expire(key, ttlSeconds).exec();
    } catch (err: any) {
      this.logger.warn(`SADD ${key} failed: ${err?.message ?? err}`);
      this.recoverFromTimeout(err);
    }
  }

  async members(key: string): Promise<string[]> {
    try {
      return await this.client.smembers(key);
    } catch (err: any) {
      this.logger.warn(`SMEMBERS ${key} failed: ${err?.message ?? err}`);
      this.recoverFromTimeout(err);
      return [];
    }
  }

  async incrementVersion(name: string): Promise<number> {
    try {
      return await this.client.incr(name);
    } catch (err: any) {
      this.logger.warn(`INCR ${name} failed: ${err?.message ?? err}`);
      this.recoverFromTimeout(err);
      return Date.now();
    }
  }

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
