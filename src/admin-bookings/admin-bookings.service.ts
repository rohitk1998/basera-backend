import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BookingsService } from '../bookings/bookings.service';
import { BOOKING_TRANSITIONS } from '../bookings/booking-transitions';
import type { ListAdminBookingsDto } from './admin-bookings.dto';

const PD = "l.draft_data->'property_details'";
const PLACE = `coalesce(nullif(trim(${PD}->>'tehsil'),''), nullif(trim(${PD}->>'town'),''), nullif(trim(${PD}->>'city'),''))`;
const REF_RE = /^rb-?[0-9a-z]{0,6}$/i;

export interface AdminAction {
  id: 'resolve_dispute' | 'cancel';
  available: boolean;
  /** Target status in the transition matrix. */
  target?: string;
  note: string;
}

/**
 * Admin actions derived from the transition matrix. Cancel is only offered
 * from statuses BookingsService.adminCancel accepts (pre-check-in).
 */
export function deriveActions(status: string, disputeCaseStatus: string | null): AdminAction[] {
  const targets = (BOOKING_TRANSITIONS as Record<string, readonly string[]>)[status] ?? [];
  const canCancel = targets.includes('cancelled') && ['requested', 'host_review', 'offered', 'awaiting_payment', 'confirmed'].includes(status);
  const canResolve = status === 'disputed' && disputeCaseStatus === 'escalated';
  return [
    {
      id: 'resolve_dispute',
      available: status === 'disputed',
      target: 'completed',
      note:
        status !== 'disputed'
          ? 'Only a disputed booking can be resolved by an admin.'
          : canResolve
            ? 'Decide the dispute: choose the rupee amount refunded to the guest.'
            : `Dispute case is "${disputeCaseStatus ?? 'unknown'}"; it must be awaiting admin review.`,
    },
    {
      id: 'cancel',
      available: canCancel,
      target: 'cancelled',
      note: canCancel
        ? 'Admin cancel with refundMode full | policy | none (none needs a reason of 10+ characters).'
        : 'No cancel transition exists from this status.',
    },
  ];
}

@Injectable()
export class AdminBookingsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly bookings: BookingsService,
  ) {}

  private async tableExists(name: string): Promise<boolean> {
    const [r] = await this.dataSource.query(`select to_regclass($1) is not null as ok`, [`public.${name}`]);
    return !!r?.ok;
  }

  async list(f: ListAdminBookingsDto) {
    const page = f.page ?? 1;
    const pageSize = f.pageSize ?? 25;
    const q = f.q?.trim() || null;
    const refQ = q && REF_RE.test(q) ? q.toUpperCase().replace(/^RB-?/, 'RB-') : null;
    const hasPayments = await this.tableExists('payments');
    const payStatus = hasPayments ? `coalesce(p.status, 'none')` : `'none'`;
    const payJoin = hasPayments ? `left join payments p on p.booking_id = b.id` : '';
    const where = `
      ($1::text is null or b.status = $1)
      and ($2::uuid is null or b.listing_id = $2)
      and ($3::uuid is null or b.host_id = $3)
      and ($4::uuid is null or b.guest_id = $4)
      and ($5::date is null or b.move_in >= $5::date)
      and ($6::date is null or b.move_in < $6::date)
      and ($7::text is null or ${payStatus} = $7)
      and ($8::text is null or b.reference ilike $8 || '%' or ($9::text is not null and gu.full_name ilike '%' || $9 || '%'))`;
    const args = [f.status ?? null, f.listing ?? null, f.host ?? null, f.guest ?? null, f.from ?? null, f.to ?? null, f.paymentStatus ?? null, refQ, q];
    const from = `from bookings b
        join users gu on gu.id = b.guest_id
        join users ho on ho.id = b.host_id
        left join listings l on l.id = b.listing_id ${payJoin}`;
    const [{ n }] = await this.dataSource.query(`select count(*)::int as n ${from} where ${where}`, args);
    const items = await this.dataSource.query(
      `select b.id, b.reference, b.status, b.listing_id as "listingId",
              ${PD}->>'title' as "listingTitle", ${PLACE} as "listingTown",
              b.guest_id as "guestId", gu.full_name as "guestName",
              b.host_id as "hostId", ho.full_name as "hostName",
              b.move_in as "moveIn", b.move_out as "moveOut", (b.move_out - b.move_in)::int as nights,
              b.gross_booking_amount as "grossAmount", b.platform_commission as "commissionAmount",
              b.host_payout_amount as "hostPayoutAmount", b.commission_rate_bps as "commissionRateBps",
              ${payStatus} as "paymentStatus", b.pay_by_at as "payByAt", b.created_at as "createdAt"
         ${from} where ${where}
        order by b.created_at desc, b.id limit $10 offset $11`,
      [...args, pageSize, (page - 1) * pageSize],
    );
    return { success: true, items, total: n, page, pageSize };
  }

  async detail(id: string) {
    const [booking] = await this.dataSource.query(
      `select b.*, ${PD}->>'title' as listing_title, ${PLACE} as listing_town,
              gu.full_name as guest_name, ho.full_name as host_name
         from bookings b join users gu on gu.id = b.guest_id join users ho on ho.id = b.host_id
         left join listings l on l.id = b.listing_id where b.id = $1`,
      [id],
    );
    if (!booking) throw new NotFoundException('Booking not found');
    // Never expose the check-in OTP or guest-supplied idempotency key.
    delete booking.checkin_code;
    delete booking.idempotency_key;

    const [hasEvents, hasOffers, hasPayments, hasRefunds, hasLedger, hasPayouts, hasDisputes] = await Promise.all(
      ['booking_events', 'booking_offers', 'payments', 'refunds', 'ledger_entries', 'payouts', 'dispute_cases'].map((t) => this.tableExists(t)),
    );
    const q = (ok: boolean, sql: string) => (ok ? this.dataSource.query(sql, [id]) : Promise.resolve([] as any[]));

    const [events, offers, payments, refunds, ledger, payouts, disputes] = await Promise.all([
      q(hasEvents, `select id, from_status as "fromStatus", to_status as "toStatus", actor, at from booking_events where booking_id = $1 order by at`),
      q(hasOffers, `select id, version, state, price_snapshot as "priceSnapshot", conditions, host_message as "hostMessage", expires_at as "expiresAt", accepted_at as "acceptedAt", created_by as "createdBy", created_at as "createdAt" from booking_offers where booking_id = $1 order by version`),
      q(hasPayments, `select id, amount, status, cashfree_order_id as "cashfreeOrderId", paid_at as "paidAt", created_at as "createdAt" from payments where booking_id = $1 order by created_at`),
      q(hasRefunds, `select id, payment_id as "paymentId", amount, state, provider, reason, failure_reason as "failureReason", attempts, created_at as "createdAt", processed_at as "processedAt" from refunds where booking_id = $1 order by created_at`),
      q(hasLedger, `select id, entry_group as "entryGroup", line_no as "lineNo", kind, account, debit, credit, created_at as "createdAt" from ledger_entries where booking_id = $1 order by created_at, entry_group, line_no`),
      q(hasPayouts, `select id, amount, state, provider, bank_reference as "bankReference", paid_at as "paidAt", created_at as "createdAt" from payouts where booking_id = $1`),
      q(hasDisputes, `select id, category, description, requested_amount as "requestedAmount", case_status as "caseStatus", resolution_amount_to_guest as "resolutionAmountToGuest", resolved_by as "resolvedBy", negotiation_rounds as "negotiationRounds", appeal_used as "appealUsed", created_at as "createdAt", updated_at as "updatedAt" from dispute_cases where booking_id = $1 order by created_at desc limit 1`),
    ]);
    const totals = (ledger as any[]).reduce((a, e) => ({ debit: a.debit + Number(e.debit), credit: a.credit + Number(e.credit) }), { debit: 0, credit: 0 });
    const dispute = disputes[0] ?? null;
    return {
      success: true,
      booking,
      events,
      offers,
      payments,
      refunds,
      payouts,
      ledger: { entries: ledger, totals, balanced: totals.debit === totals.credit },
      dispute: dispute ? { ...dispute, adminPath: `/api/admin/disputes/${id}` } : null,
      actions: deriveActions(booking.status, dispute?.caseStatus ?? null),
    };
  }

  /**
   * Admin cancel. Disputed bookings are delegated to the dispute resolver
   * (amountToGuest required); other cancellable bookings call
   * BookingsService.adminCancel. Checked-in/completed ones are refused (409).
   */
  async cancel(adminUserId: string, id: string, reason: string, amountToGuest?: number, refundMode?: 'full' | 'policy' | 'none') {
    const [row] = await this.dataSource.query(`select status from bookings where id = $1`, [id]);
    if (!row) throw new NotFoundException('Booking not found');
    if (row.status === 'disputed') {
      if (amountToGuest === undefined) {
        throw new ConflictException('amountToGuest is required to resolve a disputed booking.');
      }
      const result = await this.bookings.resolveDispute(adminUserId, id, amountToGuest, reason);
      return { success: true, delegatedTo: 'BookingsService.resolveDispute', result };
    }
    const result = await this.bookings.adminCancel(adminUserId, id, { reason, refundMode: refundMode ?? 'policy' });
    return { ...result, delegatedTo: 'BookingsService.adminCancel' };
  }
}
