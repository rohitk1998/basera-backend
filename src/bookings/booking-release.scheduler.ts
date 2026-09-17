import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingsService } from './bookings.service';

/**
 * Polls every 5 minutes for bookings past their `escrow_release_time` and
 * releases them. This is the only path a booking takes to `completed` in
 * the new model (see BookingsService.releaseHold) — a 5-minute poll against
 * an indexed timestamp column is an imperceptible timing slop against a 24h
 * hold window, and is trivially testable by calling releaseExpiredHolds()
 * directly, unlike a lazier "release on read" approach or a full queue.
 */
@Injectable()
export class BookingReleaseScheduler {
  private readonly logger = new Logger(BookingReleaseScheduler.name);

  constructor(private readonly bookingsService: BookingsService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleExpiredHolds(): Promise<void> {
    try {
      await this.bookingsService.releaseExpiredHolds();
    } catch (err) {
      this.logger.error('[handleExpiredHolds] failed', err as Error);
    }
    // Piggybacks on this same tick rather than a second @Cron for one
    // query — a negotiating dispute with no reply in NEGOTIATION_STALE_HOURS
    // gets forced to admin review.
    try {
      await this.bookingsService.escalateStaleNegotiations();
    } catch (err) {
      this.logger.error('[escalateStaleNegotiations] failed', err as Error);
    }
  }
}
