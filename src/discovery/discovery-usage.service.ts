import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/** Counters live 8 days: enough for the admin "last days" table, and they clean themselves up. */
const TTL_S = 8 * 24 * 3600;
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Per-day request counts for paid outbound calls (budget guard + admin panel).
 * Kept in Redis, not the database: these are throw-away operational counters. A Redis flush resets the day's count.
 */
@Injectable()
export class DiscoveryUsageService {
  constructor(private readonly redis: RedisService) {}

  private k(kind: 'req' | 'err' | 'last', day: string, source: string) {
    return `discovery:usage:${kind}:${day}:${source}`;
  }

  /**
   * Atomically count one outbound request for today, but only if the day's total stays within `budget`.
   * Concurrent workers can never overshoot. Returns false (nothing counted) when exhausted or Redis is down.
   */
  async reserve(source: string, budget: number): Promise<boolean> {
    if (!(budget > 0)) return false;
    const day = utcDay();
    const ok = await this.redis.incrWithin(this.k('req', day, source), budget, TTL_S);
    if (ok) await this.redis.addToSet(`discovery:usage:sources:${day}`, source, TTL_S);
    return ok;
  }

  /** Cheap read: requests still available today for `source` (no reservation made). */
  async remaining(source: string, budget: number): Promise<number> {
    if (!(budget > 0)) return 0;
    const [n] = await this.redis.mget([this.k('req', utcDay(), source)]);
    return Math.max(0, budget - Number(n ?? 0));
  }

  async recordError(source: string, message: string): Promise<void> {
    const day = utcDay();
    await this.redis.bump(this.k('err', day, source), TTL_S);
    await this.redis.set(this.k('last', day, source), message.slice(0, 500), TTL_S);
    await this.redis.addToSet(`discovery:usage:sources:${day}`, source, TTL_S);
  }

  /** Same row shape the admin panel already reads. */
  async usage(days: number) {
    const n = Math.max(1, Math.min(days, 8));
    const rows: { source: string; day: string; requests: number; errors: number; last_error: string | null }[] = [];
    for (let i = 0; i < n; i++) {
      const day = utcDay(new Date(Date.now() - i * 86_400_000));
      const sources = (await this.redis.members(`discovery:usage:sources:${day}`)).sort();
      for (const source of sources) {
        const [req, err, last] = await this.redis.mget([this.k('req', day, source), this.k('err', day, source), this.k('last', day, source)]);
        rows.push({ source, day, requests: Number(req ?? 0), errors: Number(err ?? 0), last_error: last });
      }
    }
    return rows;
  }
}
