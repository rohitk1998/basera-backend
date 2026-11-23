import { Inject, Injectable, Logger, OnApplicationShutdown, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Job, JobsOptions, Queue } from 'bullmq';
import type Redis from 'ioredis';
import {
  QUEUE_AUTOMATION,
  QUEUE_DEAD_LETTER,
  QUEUE_DISCOVERY,
  QUEUE_NOTIFICATIONS,
  QUEUE_OUTREACH,
  QUEUE_REDIS,
  WorkQueueName,
} from './queue.constants';

export interface EnqueueOptions extends Omit<JobsOptions, 'jobId'> {
  /** Used as the BullMQ jobId: a second enqueue with the same key is dropped while the first job is retained. */
  idempotencyKey?: string;
}

export interface QueueHealth {
  ok: boolean;
  redis: 'up' | 'down' | 'unconfigured';
  queues: Record<string, Record<string, number>>;
  error?: string;
}

@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private readonly byName: Record<string, Queue>;

  constructor(
    @InjectQueue(QUEUE_NOTIFICATIONS) notifications: Queue,
    @InjectQueue(QUEUE_DISCOVERY) discovery: Queue,
    @InjectQueue(QUEUE_OUTREACH) outreach: Queue,
    @InjectQueue(QUEUE_AUTOMATION) automation: Queue,
    @InjectQueue(QUEUE_DEAD_LETTER) deadLetter: Queue,
    @Inject(QUEUE_REDIS) private readonly redis: Redis | null,
    @Optional() private readonly config?: ConfigService,
  ) {
    this.byName = {
      [QUEUE_NOTIFICATIONS]: notifications,
      [QUEUE_DISCOVERY]: discovery,
      [QUEUE_OUTREACH]: outreach,
      [QUEUE_AUTOMATION]: automation,
      [QUEUE_DEAD_LETTER]: deadLetter,
    };
    for (const q of Object.values(this.byName)) q.on('error', (e) => this.logger.warn(`queue error: ${e.message}`));
  }

  private assertConfigured(): void {
    if (!this.redis) {
      throw new Error('Queue unavailable: REDIS_URL is not set. Configure REDIS_URL to enqueue background jobs.');
    }
  }

  /** BullMQ rejects ':' in custom ids. */
  static toJobId(key: string): string {
    return key.replace(/:/g, '_');
  }

  async enqueue<T = unknown>(
    name: WorkQueueName,
    jobName: string,
    data: T,
    opts: EnqueueOptions = {},
  ): Promise<Job<T>> {
    this.assertConfigured();
    const queue = this.byName[name];
    if (!queue || (name as string) === QUEUE_DEAD_LETTER) throw new Error(`Unknown work queue "${name}"`);
    const { idempotencyKey, ...rest } = opts;
    const jobId = idempotencyKey ? QueueService.toJobId(idempotencyKey) : undefined;
    return queue.add(jobName, data as any, { ...rest, ...(jobId ? { jobId } : {}) }) as Promise<Job<T>>;
  }

  /** Park a permanently failed job on the dead-letter queue (no retries, kept for inspection / manual replay). */
  async deadLetter(queueName: string, job: Job | undefined, err: Error): Promise<void> {
    if (!job) return;
    this.assertConfigured();
    await this.byName[QUEUE_DEAD_LETTER].add(
      `${queueName}:${job.name}`,
      { queue: queueName, jobName: job.name, jobId: job.id, data: job.data, attemptsMade: job.attemptsMade, error: err.message, failedAt: new Date().toISOString() },
      { attempts: 1, jobId: QueueService.toJobId(`dl-${queueName}-${job.id}`), removeOnComplete: false, removeOnFail: false },
    );
  }

  /** True once a failed job has used up all attempts. */
  static isFinalFailure(job: Job | undefined): boolean {
    return !!job && job.attemptsMade >= (job.opts.attempts ?? 1);
  }

  getQueue(name: string): Queue | undefined {
    return this.byName[name];
  }

  async health(): Promise<QueueHealth> {
    if (!this.redis) return { ok: false, redis: 'unconfigured', queues: {} };
    try {
      const pong = await Promise.race([
        this.redis.ping(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('redis ping timeout')), 2_000).unref()),
      ]);
      if (pong !== 'PONG') throw new Error('unexpected ping reply');
      const queues: QueueHealth['queues'] = {};
      for (const [n, q] of Object.entries(this.byName)) {
        queues[n] = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
      }
      return { ok: true, redis: 'up', queues };
    } catch (e: any) {
      return { ok: false, redis: 'down', queues: {}, error: e?.message ?? String(e) };
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(Object.values(this.byName).map((q) => q.close()));
    if (this.redis) await this.redis.quit().catch(() => this.redis?.disconnect());
  }
}

/** For the health module: `await queueHealth(app.get(QueueService))`. */
export function queueHealth(service: QueueService): Promise<QueueHealth> {
  return service.health();
}
