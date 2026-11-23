import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { workerProviders } from '../queue/queue.constants';
import { DiscoveredPublicController } from './discovered-public.controller';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryProcessor } from './discovery.processor';
import { DiscoveryRunnerService } from './discovery-runner.service';
import { DiscoveryScheduler } from './discovery.scheduler';
import { DiscoveryService } from './discovery.service';
import { DiscoveryUsageService } from './discovery-usage.service';
import { DiscoveredDetailsService } from './discovered-details.service';
import { RedisModule } from '../redis/redis.module';
import { GooglePlacesClient } from './google-places.client';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [DiscoveryController, DiscoveredPublicController],
  providers: [
    DiscoveryUsageService, GooglePlacesClient, DiscoveredDetailsService, DiscoveryRunnerService, DiscoveryService, DiscoveryScheduler,
    ...workerProviders(DiscoveryProcessor),
  ],
  exports: [DiscoveryService, DiscoveredDetailsService, GooglePlacesClient],
})
export class DiscoveryModule {}
