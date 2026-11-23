import { createHash } from 'crypto';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import type { LedgerAccount } from './entities';

export interface LedgerLine {
  account: LedgerAccount;
  debit?: number;
  credit?: number;
}

export interface LedgerPost {
  /** Natural idempotency key, e.g. `payment_held:<paymentId>`. Same key => never posted twice. */
  idemKey: string;
  kind: string;
  bookingId?: string | null;
  paymentId?: string | null;
  hostId?: string | null;
  ref?: string | null;
  meta?: Record<string, unknown>;
  lines: LedgerLine[];
}

/** Deterministic uuid from the idempotency key, so entry_group is the same on every replay. */
export function groupIdFor(idemKey: string): string {
  const h = createHash('sha256').update(idemKey).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

@Injectable()
export class LedgerService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Append one balanced entry group. Idempotent: returns posted=false when the idempotency key
   * was already recorded. Throws if debits != credits (the DB trigger is the second line of defence).
   */
  async record(post: LedgerPost, manager?: EntityManager): Promise<{ posted: boolean; group: string }> {
    const lines = post.lines
      .map((l) => ({ account: l.account, debit: l.debit ?? 0, credit: l.credit ?? 0 }))
      .filter((l) => l.debit > 0 || l.credit > 0);
    const debit = lines.reduce((s, l) => s + l.debit, 0);
    const credit = lines.reduce((s, l) => s + l.credit, 0);
    if (lines.length === 0) return { posted: false, group: groupIdFor(post.idemKey) };
    if (debit !== credit || lines.some((l) => !Number.isInteger(l.debit) || !Number.isInteger(l.credit) || (l.debit > 0 && l.credit > 0))) {
      throw new InternalServerErrorException(`Unbalanced ledger post ${post.idemKey}: debit ${debit} credit ${credit}`);
    }
    const group = groupIdFor(post.idemKey);
    const meta = JSON.stringify({ ...(post.meta ?? {}), ...(post.hostId ? { hostId: post.hostId } : {}) });
    const params: unknown[] = [];
    const values = lines.map((l, i) => {
      const o = params.length;
      params.push(post.bookingId ?? null, post.paymentId ?? null, group, i + 1, post.kind, post.idemKey, l.account, l.debit, l.credit, post.ref ?? null, meta);
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11}::jsonb)`;
    });
    const sql = `insert into ledger_entries (booking_id, payment_id, entry_group, line_no, kind, idem_key, account, debit, credit, ref, meta)
                 values ${values.join(',')} on conflict do nothing returning id`;
    const run = async (m: Pick<EntityManager, 'query'>) => (await m.query(sql, params)) as unknown[];
    const rows = manager ? await run(manager) : await this.dataSource.transaction((m) => run(m));
    return { posted: rows.length > 0, group };
  }

  async entriesForBooking(bookingId: string) {
    return this.dataSource.query(
      `select id, entry_group as "entryGroup", line_no as "lineNo", kind, account, debit, credit, currency, ref, meta,
              payment_id as "paymentId", created_at as "createdAt"
         from ledger_entries where booking_id = $1 order by created_at, entry_group, line_no`,
      [bookingId],
    );
  }

  /** Net credit balance of an account (credit - debit). host_payable / platform_commission are credit-normal. */
  async accountBalance(account: LedgerAccount, filter: { hostId?: string; bookingId?: string } = {}): Promise<number> {
    const rows = await this.dataSource.query(
      `select coalesce(sum(credit - debit), 0)::bigint as bal from ledger_entries
        where account = $1 and ($2::text is null or meta->>'hostId' = $2) and ($3::uuid is null or booking_id = $3)`,
      [account, filter.hostId ?? null, filter.bookingId ?? null],
    );
    return Number(rows[0]?.bal ?? 0);
  }

  hostPayableBalance(hostId: string): Promise<number> {
    return this.accountBalance('host_payable', { hostId });
  }

  // ---- chart of accounts postings (see audit/api/finance.md) -----------------------------------

  paymentHeld(p: { paymentId: string; bookingId: string; amount: number }, manager?: EntityManager) {
    return this.record(
      {
        idemKey: `payment_held:${p.paymentId}`,
        kind: 'payment_held',
        bookingId: p.bookingId,
        paymentId: p.paymentId,
        lines: [
          { account: 'platform_cash', debit: p.amount },
          { account: 'guest_receivable', credit: p.amount },
        ],
      },
      manager,
    );
  }

  /** Move `base` of held funds to the host, less commission. */
  hostShare(
    p: { kind: string; paymentId: string; bookingId: string; hostId: string; base: number; commission: number; meta?: Record<string, unknown> },
    manager?: EntityManager,
  ) {
    return this.record(
      {
        idemKey: `${p.kind}:${p.paymentId}`,
        kind: p.kind,
        bookingId: p.bookingId,
        paymentId: p.paymentId,
        hostId: p.hostId,
        meta: { ...(p.meta ?? {}), base: p.base, commission: p.commission },
        lines: [
          { account: 'guest_receivable', debit: p.base },
          { account: 'host_payable', credit: p.base - p.commission },
          { account: 'platform_commission', credit: p.commission },
        ],
      },
      manager,
    );
  }

  refundRequested(r: { refundId: string; generation: number; paymentId: string; bookingId: string; amount: number }, manager?: EntityManager) {
    return this.record(
      {
        idemKey: `refund_requested:${r.refundId}:${r.generation}`,
        kind: 'refund_requested',
        bookingId: r.bookingId,
        paymentId: r.paymentId,
        ref: r.refundId,
        lines: [
          { account: 'guest_receivable', debit: r.amount },
          { account: 'refunds', credit: r.amount },
        ],
      },
      manager,
    );
  }

  refundSettled(r: { refundId: string; paymentId: string; bookingId: string; amount: number }, manager?: EntityManager) {
    return this.record(
      {
        idemKey: `refund_settled:${r.refundId}`,
        kind: 'refund_settled',
        bookingId: r.bookingId,
        paymentId: r.paymentId,
        ref: r.refundId,
        lines: [
          { account: 'refunds', debit: r.amount },
          { account: 'platform_cash', credit: r.amount },
        ],
      },
      manager,
    );
  }

  refundFailed(r: { refundId: string; generation: number; paymentId: string; bookingId: string; amount: number }, manager?: EntityManager) {
    return this.record(
      {
        idemKey: `refund_failed:${r.refundId}:${r.generation}`,
        kind: 'refund_failed',
        bookingId: r.bookingId,
        paymentId: r.paymentId,
        ref: r.refundId,
        lines: [
          { account: 'refunds', debit: r.amount },
          { account: 'guest_receivable', credit: r.amount },
        ],
      },
      manager,
    );
  }

  payoutPaid(p: { payoutId: string; paymentId: string; bookingId: string; hostId: string; amount: number; reference?: string }, manager?: EntityManager) {
    return this.record(
      {
        idemKey: `payout_paid:${p.payoutId}`,
        kind: 'payout_paid',
        bookingId: p.bookingId,
        paymentId: p.paymentId,
        hostId: p.hostId,
        ref: p.reference ?? p.payoutId,
        lines: [
          { account: 'host_payable', debit: p.amount },
          { account: 'platform_cash', credit: p.amount },
        ],
      },
      manager,
    );
  }

  adjustment(a: { id: string; hostId: string; bookingId?: string | null; direction: 'host_credit' | 'host_debit'; amount: number }, manager?: EntityManager) {
    const credit = a.direction === 'host_credit';
    return this.record(
      {
        idemKey: `adjustment:${a.id}`,
        kind: 'adjustment',
        bookingId: a.bookingId ?? null,
        hostId: a.hostId,
        ref: a.id,
        lines: [
          { account: 'adjustments', [credit ? 'debit' : 'credit']: a.amount },
          { account: 'host_payable', [credit ? 'credit' : 'debit']: a.amount },
        ],
      },
      manager,
    );
  }
}
