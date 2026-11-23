import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DEFAULT_FREE_LISTING_CAP, PlatformSettingsService, SETTING_FREE_LISTING_CAP } from './platform-settings.service';

export interface ResolvedRate {
  rateBps: number;
  agreementId: string | null;
  /** agreement = rate from the winning agreement; free-cap = zeroed by the free-listing cap; env-fallback = no agreement found. */
  rule: 'agreement' | 'free-cap' | 'env-fallback';
  scope: 'property' | 'host' | 'global' | null;
}

/**
 * Commission rate resolution. Priority property > host > global (one agreement per scope at any
 * instant is guaranteed by the DB exclusion constraint). Then the free-cap rule: while the property is
 * within the first N active properties (N = platform_settings.free_listing_cap, or the winning
 * agreement's free_period_cap), the rate is 0 regardless of agreement.
 *
 * "Active" = listing status 'live' OR it has ever had a booking_events row to_status='confirmed'.
 * A property already active is free when its creation-order rank among active properties <= cap
 * (so total <= cap means everyone is free, and early properties stay free once the cap is passed).
 * A not-yet-active property is free when the active count is still below the cap.
 */
@Injectable()
export class CommissionService {
  private readonly logger = new Logger(CommissionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: PlatformSettingsService,
    private readonly config: ConfigService,
  ) {}

  /** Documented fallback used only when the agreements table is empty/unavailable (env PLATFORM_COMMISSION_PERCENTAGE). */
  private envFallbackBps(): number {
    return Math.round((this.config.get<number>('PLATFORM_COMMISSION_PERCENTAGE') ?? 0) * 100);
  }

  async resolveRate(listingId: string, hostId: string, at: Date = new Date(), manager?: EntityManager): Promise<ResolvedRate> {
    const db = manager ?? this.dataSource;
    let agreement: { id: string; scope: ResolvedRate['scope']; rate_bps: number; free_period_cap: number | null } | undefined;
    try {
      const rows = await db.query(
        `select id, scope, rate_bps, free_period_cap from commission_agreements
          where effective_from <= $3 and (effective_to is null or effective_to > $3)
            and ((scope = 'property' and scope_id = $1) or (scope = 'host' and scope_id = $2) or scope = 'global')
          order by case scope when 'property' then 0 when 'host' then 1 else 2 end
          limit 1`,
        [listingId, hostId, at],
      );
      agreement = rows[0];
    } catch (e) {
      this.logger.warn(`commission agreements unavailable, using env fallback: ${(e as Error).message}`);
    }
    if (!agreement) {
      return { rateBps: this.envFallbackBps(), agreementId: null, rule: 'env-fallback', scope: null };
    }
    const base: ResolvedRate = { rateBps: Number(agreement.rate_bps), agreementId: agreement.id, rule: 'agreement', scope: agreement.scope };
    if (base.rateBps === 0) return base;

    const cap = agreement.free_period_cap ?? (await this.settings.get<number>(SETTING_FREE_LISTING_CAP, DEFAULT_FREE_LISTING_CAP));
    if (cap > 0 && (await this.isWithinFreeCap(listingId, cap, db))) {
      return { ...base, rateBps: 0, rule: 'free-cap' };
    }
    return base;
  }

  async isWithinFreeCap(listingId: string, cap: number, db: Pick<DataSource, 'query'> = this.dataSource): Promise<boolean> {
    const rows = await db.query(
      `with active as (
         select l.id, l.created_at from listings l
          where l.status = 'live'
             or exists (select 1 from bookings b join booking_events e on e.booking_id = b.id and e.to_status = 'confirmed'
                         where b.listing_id = l.id)
       )
       select (select count(*)::int from active) as total,
              exists (select 1 from active where id = $1) as is_active,
              (select count(*)::int from active a where a.created_at <= (select created_at from listings where id = $1)) as rank`,
      [listingId],
    );
    const { total, is_active, rank } = rows[0] ?? { total: 0, is_active: false, rank: 0 };
    return is_active ? Number(rank) <= cap : Number(total) < cap;
  }
}
