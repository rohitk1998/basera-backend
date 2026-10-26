import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

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
