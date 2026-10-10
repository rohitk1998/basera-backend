import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Reads CAPTURE_LOCATION_BYPASS once. TEST ONLY: when on, the server skips the
 * LOCATION checks of in-app camera capture (see capture.util.ts). The value is
 * never taken from a client. env.validation.ts refuses to boot with it on in
 * production.
 */
@Injectable()
export class CaptureConfigService implements OnModuleInit {
  private readonly logger = new Logger(CaptureConfigService.name);
  readonly locationBypass: boolean;

  constructor(config: ConfigService) {
    const v = config.get<unknown>('CAPTURE_LOCATION_BYPASS');
    this.locationBypass = v === true || v === 'true' || v === '1';
  }

  onModuleInit() {
    if (this.locationBypass) this.logger.warn('CAPTURE LOCATION BYPASS IS ENABLED — test use only');
  }
}
