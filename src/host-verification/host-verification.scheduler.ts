import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HostVerificationService } from './host-verification.service';

@Injectable()
export class HostVerificationScheduler {
  private readonly logger = new Logger(HostVerificationScheduler.name);

  constructor(private readonly service: HostVerificationService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweep(): Promise<void> {
    try {
      const { expired, purged } = await this.service.sweep();
      if (expired || purged) this.logger.log(`expired ${expired} case(s), purged ${purged}`);
    } catch (err) {
      this.logger.error('[sweep] failed', err as Error);
    }
  }
}
