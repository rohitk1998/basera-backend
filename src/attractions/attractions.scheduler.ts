import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AttractionsImportService } from './attractions-import.service';

/**
 * Re-runs the import every three months (03:30 on the 1st of Jan/Apr/Jul/Oct)
 * so newly mapped places reach the admin queue as drafts. Nothing goes live
 * without a review.
 */
@Injectable()
export class AttractionsScheduler {
  private readonly logger = new Logger(AttractionsScheduler.name);

  constructor(private readonly importer: AttractionsImportService) {}

  @Cron('30 3 1 1,4,7,10 *', { timeZone: 'Asia/Kolkata' })
  async quarterlyImport() {
    if (!this.importer.isConfigured() || this.importer.getStatus().running)
      return;
    try {
      await this.importer.runNow();
    } catch (err) {
      this.logger.warn(`Scheduled import failed: ${(err as Error).message}`);
    }
  }
}
