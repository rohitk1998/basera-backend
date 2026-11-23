import { Inject, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown, Optional, BadRequestException } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { PROCESSOR_METADATA } from '@nestjs/bullmq/dist/bull.constants';
import { WorkerHost } from '@nestjs/bullmq';
import { Worker } from 'bullmq';
import type Redis from 'ioredis';
import { JobRouter } from './job-router';
import { JobsLogService } from './jobs-log.service';
import { QueueJobRegistry } from './queue-job-registry';
import { QUEUE_DEAD_LETTER, QUEUE_REDIS, WORK_QUEUES, workersEnabled } from './queue.constants';
import { QueueService } from './queue.service';

/**
 * Pre-router @Processor classes that other modules still own. They are ADOPTED at boot: their private Worker is
 * closed and their known job names are routed to process() by the single per-queue worker, so they stop sharing a
 * queue with a competing consumer (which silently completed, or failed, each other's jobs). A processor not listed
 * here is left running and a warning is logged: add it, or migrate it to QueueJobRegistry.register().
 * Remove an entry when its module is migrated.
 */
export const LEGACY_PROCESSOR_JOBS: Record<string, string[]> = {
  BookingOffersProcessor: ['offers.expire-sweep'],
  PaymentsReconcileProcessor: ['finance.reconcile'],
  ExampleProcessor: ['example.ping'],
};

export const ROUTER_WORKER_CONCURRENCY = 8;

@Injectable()
export class JobRouterService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobRouterService.name);
  private readonly workers: Worker[] = [];
  readonly router: JobRouter;

  constructor(
    private readonly registry: QueueJobRegistry,
    private readonly jobsLog: JobsLogService,
    private readonly queues: QueueService,
    @Inject(QUEUE_REDIS) private readonly redis: Redis | null,
    @Optional() private readonly discovery?: DiscoveryService,
  ) {
    this.router = new JobRouter(registry, jobsLog, queues);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!workersEnabled() || !this.redis) return;
    await this.adoptLegacyProcessors();
    for (const queue of WORK_QUEUES) {
      const worker = new Worker(queue, (job, token) => this.router.dispatch(queue, job, token), {
        connection: this.redis.duplicate(),
        prefix: 'RhenBasera:bull',
        concurrency: ROUTER_WORKER_CONCURRENCY,
      });
      worker.on('failed', (job, err) => void this.router.onFailed(queue, job, err));
      worker.on('error', (err) => this.logger.warn(`worker ${queue} error: ${err.message}`));
      this.workers.push(worker);
      this.logger.log(`router worker up on "${queue}" (${this.registry.list(queue).map((j) => j.name).join(', ') || 'no handlers'})`);
    }
  }

  private async adoptLegacyProcessors(): Promise<void> {
    if (!this.discovery) return;
    for (const wrapper of this.discovery.getProviders()) {
      const inst = wrapper.instance as WorkerHost | undefined;
      if (!inst || !(inst instanceof WorkerHost)) continue;
      const cls = inst.constructor as { name: string };
      const meta = Reflect.getMetadata(PROCESSOR_METADATA, inst.constructor) as { name?: string } | undefined;
      const queue = meta?.name;
      const names = LEGACY_PROCESSOR_JOBS[cls.name];
      if (!queue || !names) {
        this.logger.warn(`@Processor ${cls.name} still owns its own worker on "${queue}" and competes with the router. Migrate it to QueueJobRegistry.`);
        continue;
      }
      for (const name of names) {
        if (!this.registry.get(queue, name)) this.registry.register(queue, name, (job) => inst.process(job));
      }
      try {
        // A worker's Redis connection can emit 'error' while it is being closed; with no listener Node treats
        // that as an uncaught exception and the whole API dies at boot. Swallow it (it is expected here).
        inst.worker.on('error', (err: Error) => this.logger.debug(`legacy worker ${cls.name}: ${err.message}`));
        // Closing a worker whose Redis connection is still being established makes ioredis reject the
        // pending connect, and BullMQ re-emits that on an internal connection nobody listens to. Let the
        // connection finish first, then close it cleanly.
        await inst.worker.waitUntilReady().catch(() => undefined);
        await inst.worker.close();
        this.logger.log(`adopted legacy processor ${cls.name} (${queue}: ${names.join(', ')})`);
      } catch (e: any) {
        this.logger.warn(`could not close ${cls.name} worker: ${e?.message ?? e}`);
      }
    }
  }

  /** Retry a failed job (in place) or replay a dead-lettered one onto its original queue. */
  async retry(logId: string): Promise<{ retried: 'failed' | 'dead-letter' }> {
    if (!/^\d+$/.test(logId)) throw new BadRequestException('Invalid job id');
    const row = await this.jobsLog.get(logId);
    if (!row) throw new NotFoundException('Job not found in jobs_log');
    if (row.state !== 'failed' && row.state !== 'dead') throw new BadRequestException(`Only failed or dead jobs can be retried (state: ${row.state})`);
    const queue = this.queues.getQueue(row.queue);
    const dlq = this.queues.getQueue(QUEUE_DEAD_LETTER);
    if (!queue || !dlq) throw new BadRequestException('Unknown queue');
    const dlJob = await dlq.getJob(QueueService.toJobId(`dl-${row.queue}-${row.job_id}`));
    const original = await queue.getJob(row.job_id);
    if (original && (await original.isFailed())) {
      await original.retry('failed');
      if (dlJob) await dlJob.remove().catch(() => undefined);
      return { retried: 'failed' };
    }
    if (!dlJob) throw new NotFoundException('Job is no longer retained in BullMQ (history expired)');
    const d = dlJob.data as { queue: string; jobName: string; data: unknown };
    await this.queues.enqueue(d.queue as any, d.jobName, d.data, { idempotencyKey: `retry-${row.job_id}-${Date.now()}`, attempts: 3 });
    await dlJob.remove().catch(() => undefined);
    return { retried: 'dead-letter' };
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.workers.map((w) => w.close()));
  }
}
