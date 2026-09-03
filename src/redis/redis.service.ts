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
    });
    this.client.on('error', (err) => this.logger.warn(`Redis connection error: ${err.message}`));
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (err: any) {
      this.logger.warn(`GET ${key} failed: ${err?.message ?? err}`);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } catch (err: any) {
      this.logger.warn(`SET ${key} failed: ${err?.message ?? err}`);
    }
  }

  async onModuleDestroy() {
    await this.client.quit().catch(() => {});
  }
}
