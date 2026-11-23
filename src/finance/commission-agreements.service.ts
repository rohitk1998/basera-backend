import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FinanceAuditService } from './finance-audit.service';
import type { CommissionScope } from './entities';

export interface AgreementInput {
  scope: CommissionScope;
  scopeId?: string | null;
  rateBps: number;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  freePeriodCap?: number | null;
  reason?: string;
}

@Injectable()
export class CommissionAgreementsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: FinanceAuditService,
  ) {}

  list(scope?: string) {
    return this.dataSource.query(
      `select * from commission_agreements where ($1::text is null or scope = $1) order by scope, scope_id nulls first, effective_from desc`,
      [scope ?? null],
    );
  }

  async create(actor: string, i: AgreementInput) {
    if ((i.scope === 'global') !== (i.scopeId == null)) throw new BadRequestException('scopeId is required for host/property scope and forbidden for global.');
    if (i.effectiveTo && i.effectiveFrom && new Date(i.effectiveTo) <= new Date(i.effectiveFrom)) throw new BadRequestException('effectiveTo must be after effectiveFrom.');
    try {
      const rows = await this.dataSource.query(
        `insert into commission_agreements (scope, scope_id, rate_bps, effective_from, effective_to, free_period_cap, reason, created_by)
         values ($1,$2,$3,coalesce($4::timestamptz, now()),$5,$6,$7,$8) returning *`,
        [i.scope, i.scopeId ?? null, i.rateBps, i.effectiveFrom ?? null, i.effectiveTo ?? null, i.freePeriodCap ?? null, i.reason ?? null, actor],
      );
      await this.audit.log(actor, 'commission_agreement.create', 'commission_agreement', rows[0].id, { ...i });
      return rows[0];
    } catch (e: any) {
      if (e?.code === '23P01') throw new ConflictException('Overlaps an existing agreement for the same scope. End-date the current one first.');
      throw e;
    }
  }

  /** Rates are immutable history: only end-dating, the cap and the reason can change. */
  async update(actor: string, id: string, p: { effectiveTo?: string | null; freePeriodCap?: number | null; reason?: string }) {
    try {
      const rows = await this.dataSource.query(
        `update commission_agreements set effective_to = case when $2::boolean then $3::timestamptz else effective_to end,
                free_period_cap = case when $4::boolean then $5::int else free_period_cap end,
                reason = coalesce($6, reason)
          where id = $1 returning *`,
        [id, 'effectiveTo' in p, p.effectiveTo ?? null, 'freePeriodCap' in p, p.freePeriodCap ?? null, p.reason ?? null],
      );
      if (!rows[0]) throw new NotFoundException('Agreement not found');
      await this.audit.log(actor, 'commission_agreement.update', 'commission_agreement', id, { ...p });
      return rows[0];
    } catch (e: any) {
      if (e?.code === '23P01') throw new ConflictException('Overlaps an existing agreement for the same scope.');
      if (e?.code === '23514') throw new BadRequestException('effectiveTo must be after effectiveFrom.');
      throw e;
    }
  }

  /** Only agreements that have not started yet (and so cannot be on any booking) may be deleted. */
  async remove(actor: string, id: string) {
    const rows = await this.dataSource.query(
      `delete from commission_agreements a where a.id = $1 and a.effective_from > now()
         and not exists (select 1 from bookings b where b.commission_agreement_id = a.id) returning id`,
      [id],
    );
    if (!rows[0]) throw new ConflictException('Only agreements that have not started and are unused can be deleted; end-date others instead.');
    await this.audit.log(actor, 'commission_agreement.delete', 'commission_agreement', id, {});
  }
}
