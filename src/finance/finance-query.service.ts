import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LedgerService } from './ledger.service';

const PAID_STATUSES = ['held', 'released_to_host', 'split', 'refunded'];

export interface PaymentFilters {
  status?: string;
  hostId?: string;
  guestId?: string;
  bookingId?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

/** Spreadsheet-safe CSV cell: quote, double quotes, and neutralise formula injection. */
export function csvCell(v: unknown): string {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

@Injectable()
export class FinanceQueryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Every figure carries its definition so the dashboard can show numerator/denominator.
   * Amounts are integer rupees.
   */
  async summary(from?: string, to?: string) {
    const params = [from ?? null, to ?? null];
    const range = `($1::timestamptz is null or p.paid_at >= $1) and ($2::timestamptz is null or p.paid_at < $2)`;
    const [pay] = await this.dataSource.query(
      `select count(*)::int as payments, coalesce(sum(p.amount),0)::bigint as gmv,
              coalesce(sum(p.amount) filter (where p.status in ('released_to_host','split')),0)::bigint as released_gmv
         from payments p where p.status = any($3) and ${range}`,
      [...params, PAID_STATUSES],
    );
    const [commission] = await this.dataSource.query(
      `select coalesce(sum(credit - debit),0)::bigint as v from ledger_entries
        where account = 'platform_commission' and ($1::timestamptz is null or created_at >= $1) and ($2::timestamptz is null or created_at < $2)`,
      params,
    );
    const [refunds] = await this.dataSource.query(
      `select coalesce(sum(amount) filter (where state = 'success'),0)::bigint as settled,
              coalesce(sum(amount) filter (where state in ('requested','pending')),0)::bigint as in_flight,
              coalesce(sum(amount) filter (where state = 'failed'),0)::bigint as failed,
              count(*) filter (where state = 'failed')::int as failed_count
         from refunds where ($1::timestamptz is null or created_at >= $1) and ($2::timestamptz is null or created_at < $2)`,
      params,
    );
    const [payouts] = await this.dataSource.query(
      `select coalesce(sum(amount) filter (where state in ('pending','approved','processing')),0)::bigint as open_amount,
              count(*) filter (where state in ('pending','approved','processing'))::int as open_count,
              coalesce(sum(amount) filter (where state = 'paid'),0)::bigint as paid_amount,
              count(*) filter (where state = 'paid')::int as paid_count,
              count(*)::int as total_count
         from payouts where ($1::timestamptz is null or created_at >= $1) and ($2::timestamptz is null or created_at < $2)`,
      params,
    );
    const hostPayables = await this.ledger.accountBalance('host_payable');
    const gmv = Number(pay.gmv);
    const releasedGmv = Number(pay.released_gmv);
    const commissionAccrued = Number(commission.v);
    return {
      success: true,
      range: { from: from ?? null, to: to ?? null },
      gmv: { amount: gmv, payments: pay.payments },
      releasedGmv: releasedGmv,
      commissionAccrued,
      effectiveCommissionRate: { numerator: commissionAccrued, denominator: releasedGmv, pct: releasedGmv > 0 ? Math.round((commissionAccrued / releasedGmv) * 10_000) / 100 : 0 },
      refunds: { settled: Number(refunds.settled), inFlight: Number(refunds.in_flight), failed: Number(refunds.failed), failedCount: refunds.failed_count },
      hostPayables,
      payouts: {
        pending: { amount: Number(payouts.open_amount), count: payouts.open_count },
        settled: { amount: Number(payouts.paid_amount), count: payouts.paid_count },
        settledRate: { numerator: payouts.paid_count, denominator: payouts.total_count },
      },
      definitions: {
        gmv: 'Sum of payments.amount for payments that reached held/released_to_host/split/refunded, by paid_at. Denominator for nothing; a raw total.',
        releasedGmv: 'Subset of GMV whose funds were released to the host (released_to_host or split): the base commission is earned on.',
        commissionAccrued: 'Net credit of ledger account platform_commission (commission recognised when funds are released).',
        effectiveCommissionRate: 'commissionAccrued / releasedGmv. 0 while the free period applies.',
        refunds: 'settled = refunds in state success; inFlight = requested|pending; failed = needs retry.',
        hostPayables: 'Net credit of ledger account host_payable: owed to hosts, not yet paid out (all time, ignores the range).',
        payouts: 'pending = payouts in pending|approved|processing; settled = paid. settledRate = paid payouts / all payouts created in range.',
      },
    };
  }

  async listPayments(f: PaymentFilters) {
    const where = [
      `($1::text is null or p.status = $1)`,
      `($2::uuid is null or b.host_id = $2)`,
      `($3::uuid is null or b.guest_id = $3)`,
      `($4::uuid is null or p.booking_id = $4)`,
      `($5::timestamptz is null or p.created_at >= $5)`,
      `($6::timestamptz is null or p.created_at < $6)`,
    ].join(' and ');
    const args = [f.status ?? null, f.hostId ?? null, f.guestId ?? null, f.bookingId ?? null, f.from ?? null, f.to ?? null];
    const [{ n }] = await this.dataSource.query(`select count(*)::int n from payments p join bookings b on b.id = p.booking_id where ${where}`, args);
    const items = await this.dataSource.query(
      `select p.id, p.booking_id as "bookingId", p.amount, p.status, p.cashfree_order_id as "cashfreeOrderId", p.cf_payment_id as "cfPaymentId",
              p.paid_at as "paidAt", p.created_at as "createdAt", b.host_id as "hostId", b.guest_id as "guestId",
              b.commission_rate_bps as "commissionRateBps",
              coalesce((select sum(r.amount) from refunds r where r.payment_id = p.id and r.state = 'success'),0)::int as "refundedAmount"
         from payments p join bookings b on b.id = p.booking_id where ${where}
        order by p.created_at desc limit $7 offset $8`,
      [...args, f.pageSize, (f.page - 1) * f.pageSize],
    );
    return { success: true, items, total: n, page: f.page, pageSize: f.pageSize };
  }

  async paymentDetail(id: string) {
    const rows = await this.dataSource.query(
      `select p.*, b.host_id, b.guest_id, b.status as booking_status, b.commission_rate_bps, b.commission_agreement_id
         from payments p join bookings b on b.id = p.booking_id where p.id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Payment not found');
    const [refunds, payouts, ledger] = await Promise.all([
      this.dataSource.query('select * from refunds where payment_id = $1 order by created_at', [id]),
      this.dataSource.query('select * from payouts where payment_id = $1', [id]),
      this.dataSource.query('select kind, account, debit, credit, entry_group as "entryGroup", created_at as "createdAt" from ledger_entries where payment_id = $1 order by created_at, line_no', [id]),
    ]);
    return { success: true, payment: rows[0], refunds, payouts, ledger };
  }

  async ledgerForBooking(bookingId: string) {
    const entries = await this.ledger.entriesForBooking(bookingId);
    const totals = entries.reduce((a: any, e: any) => ({ debit: a.debit + e.debit, credit: a.credit + e.credit }), { debit: 0, credit: 0 });
    return { success: true, bookingId, entries, totals, balanced: totals.debit === totals.credit };
  }

  listRefunds(state: string | undefined, page: number, pageSize: number) {
    return this.dataSource.query(
      `select * from refunds where ($1::text is null or state = $1) order by created_at desc limit $2 offset $3`,
      [state ?? null, pageSize, (page - 1) * pageSize],
    );
  }

  listPayouts(state: string | undefined, hostId: string | undefined, page: number, pageSize: number) {
    return this.dataSource.query(
      `select * from payouts where ($1::text is null or state = $1) and ($2::uuid is null or host_id = $2)
        order by created_at desc limit $3 offset $4`,
      [state ?? null, hostId ?? null, pageSize, (page - 1) * pageSize],
    );
  }

  async hostBalance(hostId: string) {
    return { success: true, hostId, hostPayable: await this.ledger.hostPayableBalance(hostId) };
  }

  /** Settlement report: one row per paid payment. */
  async settlementCsv(from?: string, to?: string): Promise<string> {
    const rows = await this.dataSource.query(
      `select p.id as payment_id, p.booking_id, b.host_id, b.guest_id, p.status, p.amount, p.paid_at,
              b.commission_rate_bps,
              coalesce((select sum(credit - debit) from ledger_entries l where l.payment_id = p.id and l.account = 'platform_commission'),0) as commission,
              coalesce((select sum(r.amount) from refunds r where r.payment_id = p.id and r.state = 'success'),0) as refunded,
              coalesce((select sum(credit - debit) from ledger_entries l where l.payment_id = p.id and l.account = 'host_payable'),0) as host_payable_net,
              po.state as payout_state, po.amount as payout_amount, po.bank_reference, po.paid_at as payout_paid_at
         from payments p join bookings b on b.id = p.booking_id left join payouts po on po.payment_id = p.id
        where p.status = any($1) and ($2::timestamptz is null or p.paid_at >= $2) and ($3::timestamptz is null or p.paid_at < $3)
        order by p.paid_at limit 50000`,
      [PAID_STATUSES, from ?? null, to ?? null],
    );
    const cols = ['payment_id', 'booking_id', 'host_id', 'guest_id', 'status', 'amount', 'paid_at', 'commission_rate_bps', 'commission', 'refunded', 'host_payable_net', 'payout_state', 'payout_amount', 'bank_reference', 'payout_paid_at'];
    return [cols.join(','), ...rows.map((r: any) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
  }
}
