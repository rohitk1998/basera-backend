import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { runExclusive } from '../common/leader-lock';
import { AttractionsImportService } from './attractions-import.service';

@Injectable()
export class AttractionsScheduler {
  private readonly logger = new Logger(AttractionsScheduler.name);

  constructor(private readonly importer: AttractionsImportService) {}

  @Cron('30 3 1 1,4,7,10 *', { timeZone: 'Asia/Kolkata' })
  async quarterlyImport() {
    await runExclusive('cron:attractions-import', 6 * 3600_000, () => this.runImport());
  }

  private async runImport() {
    if (!this.importer.isConfigured() || this.importer.getStatus().running)
      return;
    try {
      await this.importer.runNow();
    } catch (err) {
      this.logger.warn(`Scheduled import failed: ${(err as Error).message}`);
    }
  }
}
