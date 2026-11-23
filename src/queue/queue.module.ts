import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { DiscoveryModule } from '@nestjs/core';
import IORedis from 'ioredis';
import { ALL_QUEUES, DEFAULT_JOB_OPTIONS, QUEUE_REDIS } from './queue.constants';
import { QueueService } from './queue.service';
import { JobRouterService } from './job-router.service';
import { JobsLogService } from './jobs-log.service';
import { QueueJobRegistry } from './queue-job-registry';

/**
 * Shared BullMQ connection from REDIS_URL. BullMQ requires maxRetriesPerRequest:null.
 * If REDIS_URL is absent the module still loads (tests); QueueService.enqueue then throws a clear error.
 * Consumption is opt-in per process: see QUEUE_WORKERS / workerProviders() in queue.constants.ts.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    DiscoveryModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL') || process.env.REDIS_URL;
        return {
          connection: url
            ? new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: true })
            : { host: '127.0.0.1', port: 1, lazyConnect: true, maxRetriesPerRequest: null, retryStrategy: () => null },
          prefix: 'RhenBasera:bull',
          defaultJobOptions: DEFAULT_JOB_OPTIONS,
        };
      },
    }),
    BullModule.registerQueue(...ALL_QUEUES.map((name) => ({ name }))),
  ],
  providers: [
    {
      provide: QUEUE_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL') || process.env.REDIS_URL;
        if (!url) {
          new Logger('QueueModule').warn('REDIS_URL not set: background queues are disabled');
          return null;
        }
        return new IORedis(url, { maxRetriesPerRequest: null, lazyConnect: true });
      },
    },
    QueueService,
    QueueJobRegistry,
    JobsLogService,
    JobRouterService,
  ],
  exports: [QueueService, BullModule, QueueJobRegistry, JobsLogService, JobRouterService],
})
export class QueueModule {}
