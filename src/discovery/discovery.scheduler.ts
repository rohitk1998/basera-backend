import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CronTime } from 'cron';
import { DataSource } from 'typeorm';
import { runExclusive } from '../common/leader-lock';
import { DiscoveryService } from './discovery.service';

@Injectable()
export class DiscoveryScheduler {
  private readonly logger = new Logger(DiscoveryScheduler.name);

  constructor(private readonly ds: DataSource, private readonly discovery: DiscoveryService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    await runExclusive('cron:discovery-scheduler', 55_000, () => this.enqueueDue(new Date()));
  }

  /** A destination is due when its cron fired within the last minute. The fire time is part of the idempotency key. */
  async enqueueDue(now: Date): Promise<number> {
    const rows: { destination: string; schedule_cron: string }[] = await this.ds.query(
      `SELECT destination, schedule_cron FROM discovery_settings WHERE NOT paused AND schedule_cron IS NOT NULL AND schedule_cron <> ''`);
    let n = 0;
    for (const r of rows) {
      try {
        const fire = new CronTime(r.schedule_cron, 'UTC').getNextDateFrom(new Date(now.getTime() - 60_000)).toJSDate();
        if (fire.getTime() > now.getTime()) continue;
        const { created } = await this.discovery.createJob(
          { destination: r.destination, idempotencyKey: `sched:${r.destination}:${fire.toISOString()}` }, null);
        if (created) n++;
      } catch (e: any) {
        this.logger.warn(`schedule for ${r.destination} failed: ${e?.message ?? e}`);
      }
    }
    return n;
  }
}
