import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

export type QueueJobHandler = (job: Job, token?: string) => Promise<unknown> | unknown;

export interface JobRegistrationOptions {
  /** Max simultaneous executions of THIS job name inside this process (default 1: sweeps must not overlap). */
  concurrency?: number;
  /** Hard time limit for one attempt. On expiry the attempt fails (and retries); the handler is not killed. Default 5 min. */
  timeoutMs?: number;
}

export interface RegisteredJob {
  queue: string;
  name: string;
  handler: QueueJobHandler;
  concurrency: number;
  timeoutMs: number;
}

export const DEFAULT_JOB_TIMEOUT_MS = 5 * 60_000;

/**
 * Modules register handlers here instead of declaring their own @Processor: BullMQ creates one Worker per
 * @Processor, and every worker on a shared queue receives every job, so unrelated processors used to swallow
 * (or lose) each other's jobs. JobRouterService runs exactly ONE worker per queue and dispatches by job name.
 */
@Injectable()
export class QueueJobRegistry {
  private readonly logger = new Logger(QueueJobRegistry.name);
  private readonly jobs = new Map<string, RegisteredJob>();

  private static key(queue: string, name: string): string {
    return `${queue}\u0000${name}`;
  }

  register(queue: string, name: string, handler: QueueJobHandler, opts: JobRegistrationOptions = {}): void {
    const key = QueueJobRegistry.key(queue, name);
    if (this.jobs.has(key)) throw new Error(`Job "${name}" is already registered on queue "${queue}"`);
    this.jobs.set(key, {
      queue,
      name,
      handler,
      concurrency: Math.max(1, opts.concurrency ?? 1),
      timeoutMs: opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
    });
    this.logger.debug(`registered ${queue}/${name}`);
  }

  get(queue: string, name: string): RegisteredJob | undefined {
    return this.jobs.get(QueueJobRegistry.key(queue, name));
  }

  list(queue?: string): RegisteredJob[] {
    return [...this.jobs.values()].filter((j) => !queue || j.queue === queue);
  }
}
