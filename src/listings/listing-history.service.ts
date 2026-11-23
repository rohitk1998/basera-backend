import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { PROVENANCE_SOURCES, assertProvenanceAllowed, type ProvenanceRecord } from './listing-provenance.util';
import { UPSERT_PRICING_SQL, pricingParams, toPricingRow } from './listing-pricing.util';

export const LISTING_STATUSES = [
  'draft', 'in_review', 'needs_review', 'changes_needed', 'rejected', 'live', 'paused', 'archived',
] as const;

export type StatusTransition = {
  listingId: string;
  from: string | null;
  to: string;
  actorId?: string | null;
  reason?: string | null;
};

/**
 * Append-only status history, provenance and typed pricing writes (raw SQL: no entity registration needed).
 * Pass `manager` to join the caller's transaction.
 */
@Injectable()
export class ListingHistoryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Call site for admin review: after the status changes, `history.record({listingId, from, to, actorId, reason})`. */
  async record(t: StatusTransition, manager?: EntityManager): Promise<void> {
    if (t.from === t.to) return;
    await (manager ?? this.dataSource).query(
      `INSERT INTO listing_status_history (listing_id, from_status, to_status, actor_id, reason)
       VALUES ($1,$2,$3,$4,$5)`,
      [t.listingId, t.from, t.to, t.actorId ?? null, t.reason?.slice(0, 1000) ?? null],
    );
  }

  list(listingId: string, limit = 100) {
    return this.dataSource.query(
      `SELECT id, from_status AS "from", to_status AS "to", actor_id AS "actorId", reason, at
       FROM listing_status_history WHERE listing_id = $1 ORDER BY at DESC, id DESC LIMIT $2`,
      [listingId, Math.min(Math.max(limit, 1), 500)],
    );
  }

  async recordProvenance(listingId: string, recs: ProvenanceRecord[], manager?: EntityManager): Promise<void> {
    for (const r of recs) assertProvenanceAllowed(r);
    const m = manager ?? this.dataSource;
    for (const r of recs) {
      await m.query(
        `INSERT INTO listing_field_provenance (listing_id, field, source, captured_at, permitted_until, note)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (listing_id, field) DO UPDATE SET source = EXCLUDED.source,
           captured_at = EXCLUDED.captured_at, permitted_until = EXCLUDED.permitted_until, note = EXCLUDED.note`,
        [listingId, r.field, r.source, r.capturedAt ?? new Date(), r.permittedUntil ?? null, r.note ?? null],
      );
    }
  }

  async savePricing(listingId: string, property: Record<string, any>, manager?: EntityManager): Promise<void> {
    await (manager ?? this.dataSource).query(UPSERT_PRICING_SQL, pricingParams(listingId, toPricingRow(property)));
  }
}

export { PROVENANCE_SOURCES };
