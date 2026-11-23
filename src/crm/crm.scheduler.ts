import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { runExclusive } from '../common/leader-lock';
import { QUEUE_OUTREACH, QueueJobRegistry, QueueService } from '../queue';
import { CrmService } from './crm.service';

export const FOLLOWUP_SWEEP_JOB = 'crm.followup-sweep';

/** Producer: every 15 min enqueue one sweep (bucketed idempotency key, so N replicas enqueue once). */
@Injectable()
export class CrmScheduler {
  private readonly logger = new Logger(CrmScheduler.name);
  constructor(private readonly queues: QueueService, private readonly crm: CrmService) {}

  @Cron('*/15 * * * *')
  async tick() {
    const bucket = Math.floor(Date.now() / (15 * 60_000));
    try {
      await this.queues.enqueue(QUEUE_OUTREACH, FOLLOWUP_SWEEP_JOB, {}, { idempotencyKey: `crm-followup-${bucket}`, attempts: 3 });
    } catch (e: any) {
      // No Redis: fall back to an in-process sweep under the leader lock.
      this.logger.warn(`queue unavailable (${e?.message}); sweeping inline`);
      await runExclusive('cron:crm-followups', 10 * 60_000, () => this.crm.sweepFollowUps());
    }
  }
}

/** Consumer (only registered when QUEUE_WORKERS=true). Leader lock guards against overlapping sweeps. */
@Injectable()
export class CrmFollowUpProcessor implements OnModuleInit {
  private readonly logger = new Logger(CrmFollowUpProcessor.name);
  constructor(private readonly crm: CrmService, private readonly registry: QueueJobRegistry) {}

  onModuleInit(): void {
    this.registry.register(QUEUE_OUTREACH, FOLLOWUP_SWEEP_JOB, () => this.process());
  }

  async process(): Promise<{ created: number } | { skipped: true }> {
    const r = await runExclusive('cron:crm-followups', 10 * 60_000, () => this.crm.sweepFollowUps());
    if (!r.ran) return { skipped: true };
    if (r.result) this.logger.log(`created ${r.result} follow-up task(s)`);
    return { created: r.result };
  }
}
