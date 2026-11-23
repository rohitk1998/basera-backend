import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { runExclusive } from '../common/leader-lock';
import { HostVerificationService } from './host-verification.service';

@Injectable()
export class HostVerificationScheduler {
  private readonly logger = new Logger(HostVerificationScheduler.name);

  constructor(private readonly service: HostVerificationService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweep(): Promise<void> {
    await runExclusive('cron:host-verification-sweep', 9 * 60_000, () => this.runSweep());
  }

  /** Hourly: delete verification files whose user or case no longer exists (e.g. account deleted). */
  @Cron(CronExpression.EVERY_HOUR)
  async sweepOrphans(): Promise<void> {
    await runExclusive('cron:host-verification-orphans', 50 * 60_000, async () => {
      try {
        await this.service.sweepOrphanedFiles();
      } catch (err) {
        this.logger.error('[orphans] failed', err as Error);
      }
    });
  }

  private async runSweep(): Promise<void> {
    try {
      const { expired, purged, rescored } = await this.service.sweep();
      if (expired || purged || rescored) {
        this.logger.log(`expired ${expired} case(s), purged ${purged}, re-scored ${rescored}`);
      }
    } catch (err) {
      this.logger.error('[sweep] failed', err as Error);
    }
  }
}
