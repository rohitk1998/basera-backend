import type { DefaultJobOptions } from 'bullmq';

export const QUEUE_NOTIFICATIONS = 'notifications';
export const QUEUE_DISCOVERY = 'discovery';
export const QUEUE_OUTREACH = 'outreach';
export const QUEUE_AUTOMATION = 'automation';
export const QUEUE_DEAD_LETTER = 'deadLetter';

/** Work queues (the dead-letter queue is separate: nothing consumes it automatically). */
export const WORK_QUEUES = [QUEUE_NOTIFICATIONS, QUEUE_DISCOVERY, QUEUE_OUTREACH, QUEUE_AUTOMATION] as const;
export type WorkQueueName = (typeof WORK_QUEUES)[number];
export const ALL_QUEUES = [...WORK_QUEUES, QUEUE_DEAD_LETTER] as const;

export const QUEUE_REDIS = Symbol('QUEUE_REDIS');

export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  // Keep a bounded window of history: also bounds how long an idempotencyKey (= jobId) dedupes.
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5_000 },
};

/** True when this process should consume jobs. Web/API replicas leave QUEUE_WORKERS unset. */
export function workersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.QUEUE_WORKERS ?? '').toLowerCase() === 'true';
}

/**
 * Register processors only in worker mode:  providers: [...workerProviders(MyProcessor)].
 * Without a registered @Processor class no BullMQ Worker is created, so the replica only produces.
 */
export function workerProviders<T extends new (...args: any[]) => any>(...processors: T[]): T[] {
  return workersEnabled() ? processors : [];
}
