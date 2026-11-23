import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { FinanceAuditService } from './finance-audit.service';
import { LedgerService } from './ledger.service';
import type { PayoutEntity } from './entities';

export type ProviderResult = { status: 'processing' | 'paid'; reference?: string } | { status: 'blocked'; reason: string };

/** A rail that can move money to a host. Implementations must never pretend a transfer happened. */
export interface PayoutProvider {
  readonly name: string;
  disburse(payout: PayoutEntity): Promise<ProviderResult>;
}

/** Admin sends the money out-of-band (bank transfer) and records the bank reference via mark-paid. */
export class ManualPayoutProvider implements PayoutProvider {
  readonly name = 'manual';
  async disburse(): Promise<ProviderResult> {
    return { status: 'processing' };
  }
}

/** Cashfree Easy Split / Payouts needs merchant activation; until then every call is explicitly blocked. */
export class CashfreePayoutProvider implements PayoutProvider {
  readonly name = 'cashfree';
  async disburse(): Promise<ProviderResult> {
    return { status: 'blocked', reason: 'blocked: provider activation required' };
  }
}

@Injectable()
export class PayoutService {
  private readonly providers: Record<string, PayoutProvider> = {
    manual: new ManualPayoutProvider(),
    cashfree: new CashfreePayoutProvider(),
  };

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly audit: FinanceAuditService,
  ) {}

  /** One payout per payment; replays are no-ops. */
  async createForPayment(
    p: { bookingId: string; paymentId: string; hostId: string; amount: number },
    manager?: EntityManager,
  ): Promise<boolean> {
    const rows = await (manager ?? this.dataSource).query(
      `insert into payouts (booking_id, payment_id, host_id, amount, provider) values ($1,$2,$3,$4,'manual')
       on conflict (payment_id) do nothing returning id`,
      [p.bookingId, p.paymentId, p.hostId, p.amount],
    );
    return rows.length > 0;
  }

  private async get(id: string): Promise<PayoutEntity> {
    const rows = await this.dataSource.query('select * from payouts where id = $1', [id]);
    if (!rows[0]) throw new NotFoundException('Payout not found');
    return rows[0];
  }

  /** pending -> approved, then handed to the provider (-> processing). A blocked provider leaves it approved and 409s. */
  async approve(id: string, actor: string, providerName = 'manual'): Promise<PayoutEntity> {
    const provider = this.providers[providerName];
    if (!provider) throw new ConflictException(`Unknown payout provider "${providerName}"`);
    const upd = await this.dataSource.query(
      `update payouts set state = 'approved', approved_by = $2, approved_at = now(), provider = $3, updated_at = now()
        where id = $1 and state = 'pending' returning *`,
      [id, actor, providerName],
    );
    if (!upd.length) {
      const cur = await this.get(id);
      if (!(cur.state === 'approved' && providerName !== cur.provider)) throw new ConflictException(`Payout is "${cur.state}", only pending payouts can be approved.`);
      await this.dataSource.query(`update payouts set provider = $2, updated_at = now() where id = $1 and state = 'approved'`, [id, providerName]);
    }
    await this.audit.log(actor, 'payout.approve', 'payout', id, { provider: providerName });
    const payout = await this.get(id);
    const result = await provider.disburse(payout);
    if (result.status === 'blocked') {
      await this.dataSource.query(`update payouts set failure_reason = $2, updated_at = now() where id = $1`, [id, result.reason]);
      throw new ConflictException(result.reason);
    }
    if (result.status === 'paid') return this.markPaid(id, actor, result.reference ?? 'provider');
    await this.dataSource.query(`update payouts set state = 'processing', failure_reason = null, updated_at = now() where id = $1 and state = 'approved'`, [id]);
    return this.get(id);
  }

  async markPaid(id: string, actor: string, bankReference: string): Promise<PayoutEntity> {
    return this.dataSource.transaction(async (m) => {
      const upd = await m.query(
        `update payouts set state = 'paid', bank_reference = $2, paid_by = $3, paid_at = now(), failure_reason = null, updated_at = now()
          where id = $1 and state in ('approved','processing') returning *`,
        [id, bankReference, actor],
      );
      if (!upd.length) {
        const cur = await this.get(id);
        throw new ConflictException(`Payout is "${cur.state}"; only approved/processing payouts can be marked paid.`);
      }
      const p = upd[0] as PayoutEntity;
      await this.ledger.payoutPaid({ payoutId: p.id, paymentId: p.payment_id, bookingId: p.booking_id, hostId: p.host_id, amount: p.amount, reference: bankReference }, m);
      await this.audit.log(actor, 'payout.mark_paid', 'payout', id, { bankReference, amount: p.amount }, m);
      return p;
    });
  }

  async markFailed(id: string, actor: string, reason: string): Promise<PayoutEntity> {
    const upd = await this.dataSource.query(
      `update payouts set state = 'failed', failure_reason = $2, updated_at = now()
        where id = $1 and state in ('pending','approved','processing') returning *`,
      [id, reason],
    );
    if (!upd.length) throw new ConflictException('Payout cannot be failed from its current state.');
    await this.audit.log(actor, 'payout.fail', 'payout', id, { reason });
    return upd[0];
  }

  /** failed -> pending so it can be approved again. */
  async requeue(id: string, actor: string): Promise<PayoutEntity> {
    const upd = await this.dataSource.query(
      `update payouts set state = 'pending', failure_reason = null, updated_at = now() where id = $1 and state = 'failed' returning *`,
      [id],
    );
    if (!upd.length) throw new ConflictException('Only failed payouts can be requeued.');
    await this.audit.log(actor, 'payout.requeue', 'payout', id, {});
    return upd[0];
  }
}
