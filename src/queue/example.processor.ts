import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUE_AUTOMATION } from './queue.constants';
import { QueueService } from './queue.service';

/**
 * EXAMPLE processor (not registered anywhere). To use one:
 *   1. providers: [...workerProviders(MyProcessor)]   // only consumes when QUEUE_WORKERS=true
 *   2. producers:  queueService.enqueue('automation', 'example.ping', { n: 1 }, { idempotencyKey: 'ping-1' })
 * Handlers must be idempotent (jobs retry up to 5x). Throw to retry; after the last attempt the job is
 * copied to the dead-letter queue by onFailed.
 */
@Processor(QUEUE_AUTOMATION, { concurrency: 5 })
export class ExampleProcessor extends WorkerHost {
  private readonly logger = new Logger(ExampleProcessor.name);

  constructor(private readonly queues: QueueService) {
    super();
  }

  async process(job: Job<{ n: number }>): Promise<{ doubled: number }> {
    if (job.name !== 'example.ping') throw new Error(`Unhandled job ${job.name}`);
    return { doubled: job.data.n * 2 };
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, err: Error): Promise<void> {
    this.logger.warn(`job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
    if (QueueService.isFinalFailure(job)) await this.queues.deadLetter(QUEUE_AUTOMATION, job, err);
  }
}
