import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
