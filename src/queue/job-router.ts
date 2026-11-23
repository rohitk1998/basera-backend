import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { JobsLogService } from './jobs-log.service';
import { QueueJobRegistry } from './queue-job-registry';
import { QueueService } from './queue.service';

export class UnknownJobError extends Error {
  constructor(readonly queue: string, readonly jobName: string) {
    super(`No handler registered for job "${jobName}" on queue "${queue}"`);
    this.name = 'UnknownJobError';
  }
}

export class JobTimeoutError extends Error {
  constructor(readonly jobName: string, readonly ms: number) {
    super(`Job "${jobName}" timed out after ${ms}ms`);
    this.name = 'JobTimeoutError';
  }
}

/** Tiny in-process counting semaphore (per job name concurrency). */
export class Semaphore {
  private free: number;
  private readonly waiters: Array<() => void> = [];
  constructor(readonly size: number) { this.free = size; }
  async acquire(): Promise<void> {
    if (this.free > 0) { this.free--; return; }
    await new Promise<void>((r) => this.waiters.push(r));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next(); else this.free++;
  }
}

/**
 * Pure routing core (no BullMQ Worker): dispatch a job by name, fail loudly on an unknown name, enforce per-job
 * concurrency + timeout, and keep jobs_log current. JobRouterService wires one Worker per queue to it.
 */
export class JobRouter {
  private readonly logger = new Logger(JobRouter.name);
  private readonly semaphores = new Map<string, Semaphore>();

  constructor(
    private readonly registry: QueueJobRegistry,
    private readonly jobsLog: JobsLogService,
    private readonly queues?: Pick<QueueService, 'deadLetter'>,
  ) {}

  private sem(queue: string, name: string, size: number): Semaphore {
    const k = `${queue}/${name}`;
    let s = this.semaphores.get(k);
    if (!s) { s = new Semaphore(size); this.semaphores.set(k, s); }
    return s;
  }

  async dispatch(queue: string, job: Job, token?: string): Promise<unknown> {
    const jobId = String(job.id ?? '');
    await this.jobsLog.started(queue, jobId, job.name, (job.attemptsMade ?? 0) + 1);
    const entry = this.registry.get(queue, job.name);
    if (!entry) throw new UnknownJobError(queue, job.name); // never complete silently: retries, then dead-letter
    const sem = this.sem(queue, job.name, entry.concurrency);
    await sem.acquire();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(entry.handler(job, token)),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new JobTimeoutError(job.name, entry.timeoutMs)), entry.timeoutMs);
          timer.unref?.();
        }),
      ]);
      await this.jobsLog.completed(queue, jobId);
      return result ?? null;
    } finally {
      if (timer) clearTimeout(timer);
      sem.release();
    }
  }

  /** Worker 'failed' event: record, and park on the dead-letter queue once attempts are exhausted. */
  async onFailed(queue: string, job: Job | undefined, err: Error): Promise<void> {
    if (!job) return;
    const dead = QueueService.isFinalFailure(job);
    this.logger.warn(`${queue}/${job.name} #${job.id} failed (attempt ${job.attemptsMade}${dead ? ', final' : ''}): ${err.message}`);
    await this.jobsLog.failed(queue, String(job.id ?? ''), job.name, job.attemptsMade ?? 0, err.message, dead);
    if (dead && this.queues) {
      try {
        await this.queues.deadLetter(queue, job, err);
      } catch (e: any) {
        this.logger.error(`dead-letter failed: ${e?.message ?? e}`);
      }
    }
  }
}
