import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { HostSubscriptionEntity } from '../entities';
import { isPlanId, PLAN_PRICES, PlanId } from '../common/plans';

const PERIOD_DAYS = 30;

function periodEnd(from: Date): Date {
  return new Date(from.getTime() + PERIOD_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * One subscription per host, covering both listing-visibility tier
 * (listed/featured/pro) and the commission-replacement relationship — see
 * migrations/20260831_host_subscriptions.sql. Phase 1: DB-simulated only,
 * no real Cashfree/Razorpay billing collection. `past_due` exists in the
 * schema for forward-compatibility but nothing transitions into it yet.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    @InjectRepository(HostSubscriptionEntity)
    private readonly subscriptionsRepo: Repository<HostSubscriptionEntity>,
  ) {}

  /** Returns the host's subscription, lazily creating a free `listed`/`active` row if none exists. */
  async getForHost(hostId: string): Promise<HostSubscriptionEntity> {
    const existing = await this.subscriptionsRepo.findOne({ where: { host_id: hostId } });
    if (existing) {
      return existing;
    }
    const now = new Date();
    const created = this.subscriptionsRepo.create({
      host_id: hostId,
      plan_id: 'listed' satisfies PlanId,
      status: 'active',
      cashfree_subscription_id: null,
      amount: PLAN_PRICES.listed,
      current_period_start: now,
      current_period_end: periodEnd(now),
    });
    return this.subscriptionsRepo.save(created);
  }

  async subscribe(hostId: string, planId: string): Promise<HostSubscriptionEntity> {
    if (!isPlanId(planId)) {
      throw new BadRequestException(`Unknown plan "${planId}"`);
    }

    const existing = await this.getForHost(hostId);
    const now = new Date();

    await this.subscriptionsRepo.update(
      { id: existing.id },
      {
        plan_id: planId,
        status: 'active',
        amount: PLAN_PRICES[planId],
        cashfree_subscription_id: `SIMULATED-${randomUUID()}`,
        current_period_start: now,
        current_period_end: periodEnd(now),
        updated_at: now,
      },
    );

    return this.subscriptionsRepo.findOneOrFail({ where: { id: existing.id } });
  }

  /** Immediate effect — no fake grace period, consistent with this phase having no real billing behind it. */
  async cancel(hostId: string): Promise<HostSubscriptionEntity> {
    const existing = await this.getForHost(hostId);
    await this.subscriptionsRepo.update({ id: existing.id }, { status: 'cancelled', updated_at: new Date() });
    return this.subscriptionsRepo.findOneOrFail({ where: { id: existing.id } });
  }
}
