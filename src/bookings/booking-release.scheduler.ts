import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingsService } from './bookings.service';

@Injectable()
export class BookingReleaseScheduler {
  private readonly logger = new Logger(BookingReleaseScheduler.name);

  constructor(private readonly bookingsService: BookingsService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleExpiredHolds(): Promise<void> {
    try {
      await this.bookingsService.releaseExpiredHolds();
    } catch (err) {
      this.logger.error('[handleExpiredHolds] failed', err as Error);
    }
    try {
      await this.bookingsService.escalateStaleNegotiations();
    } catch (err) {
      this.logger.error('[escalateStaleNegotiations] failed', err as Error);
    }
  }
}
