import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Job } from 'bullmq';
import { runExclusive } from '../common/leader-lock';
import { QUEUE_AUTOMATION, QueueJobRegistry, QueueService } from '../queue';
import { InquiriesService } from './inquiries.service';

export const INQUIRY_SWEEP_JOB = 'inquiries.expire-sweep';

/** Cron (leader-locked) enqueues one sweep job per 5-minute bucket; falls back to inline when Redis is unset. */
@Injectable()
export class InquiriesScheduler {
  private readonly logger = new Logger(InquiriesScheduler.name);

  constructor(
    private readonly service: InquiriesService,
    private readonly queues: QueueService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    await runExclusive('cron:inquiry-sweep', 55_000, async () => {
      try {
        await this.queues.enqueue(QUEUE_AUTOMATION, INQUIRY_SWEEP_JOB, {}, { idempotencyKey: `inquiry-sweep-${Math.floor(Date.now() / 300_000)}`, attempts: 3 });
      } catch (e: any) {
        this.logger.warn(`queue unavailable (${e?.message ?? e}); sweeping inline`);
        try {
          await this.service.sweepExpired();
        } catch (err) {
          this.logger.error('[inquiry sweep] failed', err as Error);
        }
      }
    });
  }
}

/** Registered only in worker mode (QUEUE_WORKERS=true). The queue module's single router worker dispatches to it. */
@Injectable()
export class InquiriesProcessor implements OnModuleInit {
  constructor(
    private readonly service: InquiriesService,
    private readonly registry: QueueJobRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(QUEUE_AUTOMATION, INQUIRY_SWEEP_JOB, () => this.process());
  }

  async process(): Promise<{ expired: number }> {
    return { expired: await this.service.sweepExpired() };
  }
}
