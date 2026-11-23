import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { runExclusive } from '../common/leader-lock';
import { QUEUE_AUTOMATION, QueueJobRegistry, QueueService } from '../queue';
import { AUTOMATION_KINDS } from './automation.definitions';
import { AutomationService } from './automation.service';

export const automationJobName = (kind: string) => `automation.${kind}`;

/**
 * Every 10 min (leader-locked) enqueue one idempotent job per enabled automation on the 'automation' queue
 * (bucketed idempotency key, so N replicas enqueue once). Handlers are registered with the JobRouter in
 * every process (cheap, side-effect free); only worker replicas (QUEUE_WORKERS=true) ever consume.
 */
@Injectable()
export class AutomationScheduler implements OnModuleInit {
  private readonly logger = new Logger(AutomationScheduler.name);

  constructor(
    private readonly service: AutomationService,
    private readonly queues: QueueService,
    private readonly registry: QueueJobRegistry,
  ) {}

  onModuleInit(): void {
    for (const kind of AUTOMATION_KINDS) {
      this.registry.register(QUEUE_AUTOMATION, automationJobName(kind), () => this.service.run(kind), { concurrency: 1, timeoutMs: 4 * 60_000 });
    }
  }

  @Cron('*/10 * * * *')
  async tick(): Promise<void> {
    await runExclusive('cron:automation-tick', 9 * 60_000, async () => {
      const bucket = Math.floor(Date.now() / 600_000);
      let kinds: string[];
      try {
        kinds = await this.service.enabledKinds();
      } catch (e: any) {
        this.logger.warn(`cannot read automation settings (${e?.message ?? e}); skipping tick`);
        return;
      }
      for (const kind of kinds) {
        try {
          await this.queues.enqueue(QUEUE_AUTOMATION, automationJobName(kind), {}, { idempotencyKey: `automation-${kind}-${bucket}`, attempts: 3 });
        } catch (e: any) {
          // No Redis: run inline; reminder_log keeps it idempotent.
          this.logger.warn(`queue unavailable (${e?.message ?? e}); running ${kind} inline`);
          try { await this.service.run(kind); } catch (err) { this.logger.error(`[${kind}] failed`, err as Error); }
        }
      }
    });
  }
}
