import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FinanceAuditService } from './finance-audit.service';
import { LedgerService } from './ledger.service';
import { PlatformSettingsService, SETTING_ADJUSTMENT_THRESHOLD } from './platform-settings.service';
import type { FinanceAdjustmentEntity } from './entities';

export interface AdjustmentRequest {
  hostId: string;
  direction: 'host_credit' | 'host_debit';
  amount: number;
  reason: string;
  bookingId?: string | null;
}

/**
 * Manual money corrections. Two-person rule: requested_by must differ from approved_by.
 * Threshold (platform_settings.adjustment_second_approval_threshold, rupees): amounts at or above it
 * always need a second admin. Default 0 = every adjustment needs one. A positive threshold lets the
 * requester self-approve strictly smaller amounts (still audit logged).
 */
@Injectable()
export class AdjustmentService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly settings: PlatformSettingsService,
    private readonly audit: FinanceAuditService,
  ) {}

  async request(actor: string, req: AdjustmentRequest): Promise<FinanceAdjustmentEntity> {
    if (!Number.isInteger(req.amount) || req.amount <= 0) throw new BadRequestException('Amount must be a positive whole number of rupees.');
    const threshold = await this.settings.get<number>(SETTING_ADJUSTMENT_THRESHOLD, 0);
    const requiresSecond = req.amount >= threshold;
    const rows = await this.dataSource.query(
      `insert into finance_adjustments (booking_id, host_id, direction, amount, reason, requires_second_approval, requested_by)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [req.bookingId ?? null, req.hostId, req.direction, req.amount, req.reason, requiresSecond, actor],
    );
    await this.audit.log(actor, 'adjustment.request', 'adjustment', rows[0].id, { ...req, requiresSecond });
    return rows[0];
  }

  private async get(id: string): Promise<FinanceAdjustmentEntity> {
    const rows = await this.dataSource.query('select * from finance_adjustments where id = $1', [id]);
    if (!rows[0]) throw new NotFoundException('Adjustment not found');
    return rows[0];
  }

  async approve(id: string, actor: string, note?: string): Promise<FinanceAdjustmentEntity> {
    const adj = await this.get(id);
    if (adj.state !== 'pending') throw new ConflictException(`Adjustment is already ${adj.state}.`);
    if (adj.requires_second_approval && adj.requested_by === actor) {
      throw new ForbiddenException('A second admin must approve this adjustment.');
    }
    return this.dataSource.transaction(async (m) => {
      const upd = await m.query(
        `update finance_adjustments set state = 'approved', approved_by = $2, decision_note = $3, decided_at = now()
          where id = $1 and state = 'pending' returning *`,
        [id, actor, note ?? null],
      );
      if (!upd.length) throw new ConflictException('Adjustment is no longer pending.');
      const a = upd[0] as FinanceAdjustmentEntity;
      await this.ledger.adjustment({ id: a.id, hostId: a.host_id, bookingId: a.booking_id, direction: a.direction, amount: a.amount }, m);
      await this.audit.log(actor, 'adjustment.approve', 'adjustment', id, { note, amount: a.amount, direction: a.direction }, m);
      return a;
    });
  }

  async reject(id: string, actor: string, note?: string): Promise<FinanceAdjustmentEntity> {
    const upd = await this.dataSource.query(
      `update finance_adjustments set state = 'rejected', approved_by = null, decision_note = $2, decided_at = now()
        where id = $1 and state = 'pending' returning *`,
      [id, note ?? null],
    );
    if (!upd.length) {
      const cur = await this.get(id);
      throw new ConflictException(`Adjustment is already ${cur.state}.`);
    }
    await this.audit.log(actor, 'adjustment.reject', 'adjustment', id, { note });
    return upd[0];
  }

  list(state?: string) {
    return this.dataSource.query(
      `select * from finance_adjustments where ($1::text is null or state = $1) order by created_at desc limit 200`,
      [state ?? null],
    );
  }
}
