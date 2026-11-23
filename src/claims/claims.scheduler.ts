import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { runExclusive } from '../common/leader-lock';
import { ClaimsService } from './claims.service';

@Injectable()
export class ClaimsScheduler {
  private readonly logger = new Logger(ClaimsScheduler.name);
  constructor(private readonly service: ClaimsService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async purge(): Promise<void> {
    await runExclusive('cron:claim-evidence-purge', 50 * 60_000, async () => {
      try {
        const { purged, failed } = await this.service.purgeExpired();
        if (purged || failed) this.logger.log(`evidence purge: ${purged} deleted, ${failed} failed`);
      } catch (err) {
        this.logger.error('[purge] failed', err as Error);
      }
    });
  }
}
