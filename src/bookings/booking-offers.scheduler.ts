import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { runExclusive } from '../common/leader-lock';
import { QUEUE_AUTOMATION, QueueService } from '../queue';
import { BookingOffersService, OFFER_SWEEP_JOB } from './booking-offers.service';

/**
 * Every minute, under the leader lock, enqueue ONE idempotent sweep job on the
 * 'automation' queue (jobId per minute bucket). Without Redis the sweep runs
 * inline so offers still expire in dev. The sweep itself is idempotent, so the
 * inline fallback and the worker can never double-expire anything.
 */
@Injectable()
export class BookingOffersScheduler {
  private readonly logger = new Logger(BookingOffersScheduler.name);

  constructor(
    private readonly offers: BookingOffersService,
    @Optional() private readonly queues?: QueueService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    await runExclusive('cron:offer-sweep', 55_000, () => this.run());
  }

  async run(now = new Date()): Promise<'queued' | 'inline'> {
    if (this.queues) {
      try {
        await this.queues.enqueue(QUEUE_AUTOMATION, OFFER_SWEEP_JOB, {}, {
          idempotencyKey: `${OFFER_SWEEP_JOB}-${Math.floor(now.getTime() / 60_000)}`,
        });
        return 'queued';
      } catch (err) {
        this.logger.warn(`[offer sweep] enqueue failed, running inline: ${(err as Error).message}`);
      }
    }
    try {
      await this.offers.expireOffers(now);
    } catch (err) {
      this.logger.error('[offer sweep] failed', err as Error);
    }
    return 'inline';
  }
}

/**
 * Consumer for the sweep job. Registered via workerProviders(), i.e. only when
 * QUEUE_WORKERS=true. NOTE: BullMQ gives one Worker per @Processor, so if
 * another module also consumes 'automation', merge the two by dispatching on
 * job.name (this one throws on names it does not know).
 */
@Processor(QUEUE_AUTOMATION, { concurrency: 1 })
export class BookingOffersProcessor extends WorkerHost {
  private readonly logger = new Logger(BookingOffersProcessor.name);

  constructor(
    private readonly offers: BookingOffersService,
    private readonly queues: QueueService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== OFFER_SWEEP_JOB) throw new Error(`Unhandled automation job "${job.name}"`);
    return this.offers.expireOffers();
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, err: Error): Promise<void> {
    this.logger.warn(`job ${job?.id} failed: ${err.message}`);
    if (QueueService.isFinalFailure(job)) await this.queues.deadLetter(QUEUE_AUTOMATION, job, err);
  }
}
