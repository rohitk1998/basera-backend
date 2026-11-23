import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUE_DISCOVERY } from '../queue/queue.constants';
import { QueueJobRegistry } from '../queue/queue-job-registry';
import { DiscoveryRunnerService } from './discovery-runner.service';

/** Consumes 'discovery.run' via the queue module's single router worker. Registered only when QUEUE_WORKERS=true (see workerProviders). */
@Injectable()
export class DiscoveryProcessor implements OnModuleInit {
  private readonly logger = new Logger(DiscoveryProcessor.name);

  constructor(private readonly runner: DiscoveryRunnerService, private readonly registry: QueueJobRegistry) {}

  onModuleInit(): void {
    this.registry.register(QUEUE_DISCOVERY, 'discovery.run', (job) => this.process(job as Job<{ jobId: string }>));
  }

  async process(job: Job<{ jobId: string }>): Promise<{ ran: boolean }> {
    return this.runner.run(job.data.jobId);
  }
}
