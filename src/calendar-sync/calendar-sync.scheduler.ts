import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { runExclusive } from '../common/leader-lock';
import { CalendarSyncService } from './calendar-sync.service';

@Injectable()
export class CalendarSyncScheduler {
  private readonly logger = new Logger(CalendarSyncScheduler.name);

  constructor(private readonly service: CalendarSyncService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async refresh(): Promise<void> {
    await runExclusive('cron:calendar-sync', 55 * 60_000, () => this.runRefresh());
  }

  private async runRefresh(): Promise<void> {
    try {
      await this.service.syncAll();
    } catch (err) {
      this.logger.error('[calendar refresh] failed', err as Error);
    }
  }
}
