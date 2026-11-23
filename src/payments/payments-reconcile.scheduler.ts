import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import type { Job } from 'bullmq';
import { runExclusive } from '../common/leader-lock';
import { QUEUE_AUTOMATION, QueueJobRegistry, QueueService } from '../queue';
import { PaymentsReconciler } from './payments-reconciler.service';

export const RECONCILE_JOB = 'finance.reconcile';

/**
 * Every 5 minutes one replica (leader lock) enqueues a `finance.reconcile` job on the BullMQ
 * 'automation' queue (idempotency key = 5-minute bucket). If Redis is not configured the job runs
 * inline under the same lock. Consumption needs a replica with QUEUE_WORKERS=true.
 */
@Injectable()
export class PaymentsReconcileScheduler implements OnModuleInit {
  private readonly logger = new Logger(PaymentsReconcileScheduler.name);

  constructor(
    private readonly queues: QueueService,
    private readonly reconciler: PaymentsReconciler,
    private readonly registry: QueueJobRegistry,
  ) {}

  /** The router's single 'automation' worker dispatches `finance.reconcile` here (no private worker). */
  onModuleInit(): void {
    this.registry.register(QUEUE_AUTOMATION, RECONCILE_JOB, async () => {
      const summary = await this.reconciler.run();
      this.logger.log(`reconcile: ${JSON.stringify(summary)}`);
      return summary;
    });
  }

  @Cron('*/5 * * * *')
  async tick(): Promise<void> {
    await runExclusive('cron:finance-reconcile', 4 * 60_000, async () => {
      const bucket = Math.floor(Date.now() / 300_000);
      try {
        await this.queues.enqueue('automation', RECONCILE_JOB, {}, { idempotencyKey: `finance-reconcile-${bucket}`, attempts: 2 });
      } catch (e) {
        this.logger.warn(`queue unavailable (${(e as Error).message}); reconciling inline`);
        try {
          await this.reconciler.run();
        } catch (err) {
          this.logger.error('[finance reconcile] failed', err as Error);
        }
      }
    });
  }
}

@Processor(QUEUE_AUTOMATION, { concurrency: 1 })
export class PaymentsReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentsReconcileProcessor.name);

  constructor(
    private readonly reconciler: PaymentsReconciler,
    private readonly queues: QueueService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== RECONCILE_JOB) return undefined; // other automation jobs are not ours
    const summary = await this.reconciler.run();
    this.logger.log(`reconcile: ${JSON.stringify(summary)}`);
    return summary;
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, err: Error): Promise<void> {
    if (job?.name === RECONCILE_JOB && QueueService.isFinalFailure(job)) await this.queues.deadLetter(QUEUE_AUTOMATION, job, err);
  }
}
