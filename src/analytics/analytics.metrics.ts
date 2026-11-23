/**
 * Admin analytics metric catalogue. PURE: every metric is data (definition + SQL builder), so the definitions
 * documented in audit/api/analytics.md are exactly what executes, and tests can assert on both.
 *
 * Conventions
 *  - SQL is READ-ONLY. $1 = window start (inclusive), $2 = window end (exclusive), both timestamptz (UTC).
 *  - Each query returns ONE row: `value` (numeric or NULL) and optionally `numerator`, `denominator`, `detail` (jsonb).
 *  - `requires` lists tables read; if any is missing (later phase not migrated) the metric is `null`, never an error.
 *  - Money is integer rupees. Ratios are 0..1.
 */
export type Section = 'acquisition' | 'funnel' | 'finance' | 'operations';
export type Unit = 'count' | 'rupees' | 'hours' | 'ratio';

export interface MetricDefinition {
  numerator: string;
  denominator: string | null;
  window: string;
  source: string;
}

export interface MetricSpec {
  key: string;
  section: Section;
  label: string;
  unit: Unit;
  definition: MetricDefinition;
  requires: string[];
  build(): string;
}

export interface MetricResult {
  key: string;
  label: string;
  unit: Unit;
  value: number | null;
  numerator?: number | null;
  denominator?: number | null;
  detail?: unknown;
  /** Why value is null when it is a data-availability issue (vs. legitimately empty). */
  unavailable?: 'missing_tables' | 'error';
  missingTables?: string[];
}

const W = 'created in [from, to)';

const count = (table: string, col: string, extra = '') =>
  `SELECT count(*)::bigint AS value FROM ${table} WHERE ${col} >= $1 AND ${col} < $2 ${extra}`;

const BOOKING_CONFIRMED_PLUS = `('confirmed','checked_in','checked_out','completed','disputed')`;

export const METRICS: MetricSpec[] = [
  // ---------------- acquisition ----------------
  {
    key: 'discovered_candidates', section: 'acquisition', label: 'Discovered candidates', unit: 'count',
    definition: { numerator: 'listings rows with discovered_at in the window (claimed ones included: provenance is kept)', denominator: null, window: 'discovered_at in [from, to)', source: 'listings.discovered_at' },
    requires: ['listings'],
    build: () => count('listings', 'discovered_at'),
  },
  {
    key: 'eligible_for_outreach', section: 'acquisition', label: 'Eligible for outreach', unit: 'count',
    definition: { numerator: 'host_leads created in the window that are not self-registered, not DO_NOT_CONTACT and have a phone or email', denominator: null, window: 'host_leads.created_at in [from, to)', source: 'host_leads' },
    requires: ['host_leads'],
    build: () => count('host_leads', 'created_at', `AND source <> 'host_self_registered' AND contact_state <> 'DO_NOT_CONTACT' AND (phone IS NOT NULL OR email IS NOT NULL)`),
  },
  {
    key: 'contacted', section: 'acquisition', label: 'Contacted', unit: 'count',
    definition: { numerator: 'host_leads whose first contact happened in the window', denominator: null, window: 'first_contacted_at in [from, to)', source: 'host_leads.first_contacted_at' },
    requires: ['host_leads'],
    build: () => count('host_leads', 'first_contacted_at'),
  },
  {
    key: 'interested', section: 'acquisition', label: 'Interested', unit: 'count',
    definition: { numerator: 'host_leads that became INTERESTED in the window', denominator: null, window: 'interested_at in [from, to)', source: 'host_leads.interested_at' },
    requires: ['host_leads'],
    build: () => count('host_leads', 'interested_at'),
  },
  {
    key: 'claims_submitted', section: 'acquisition', label: 'Claims submitted', unit: 'count',
    definition: { numerator: 'property_claims submitted in the window', denominator: null, window: 'submitted_at in [from, to)', source: 'property_claims.submitted_at' },
    requires: ['property_claims'],
    build: () => count('property_claims', 'submitted_at'),
  },
  {
    key: 'claims_approved', section: 'acquisition', label: 'Claims approved', unit: 'count',
    definition: { numerator: 'property_claims decided APPROVED in the window', denominator: null, window: 'decided_at in [from, to)', source: 'property_claims.state/decided_at' },
    requires: ['property_claims'],
    build: () => count('property_claims', 'decided_at', `AND state = 'APPROVED'`),
  },
  {
    key: 'verified_properties', section: 'acquisition', label: 'Verified properties', unit: 'count',
    definition: { numerator: 'distinct claimed (not discovered) listings that an admin moved to status live in the window', denominator: null, window: 'listing_status_history.at in [from, to)', source: 'listing_status_history + listings' },
    requires: ['listing_status_history', 'listings'],
    build: () => `SELECT count(DISTINCT h.listing_id)::bigint AS value FROM listing_status_history h JOIN listings l ON l.id = h.listing_id
                   WHERE h.to_status = 'live' AND h.at >= $1 AND h.at < $2 AND l.is_discovered = false`,
  },
  {
    key: 'published_bookable', section: 'acquisition', label: 'Published bookable properties (now)', unit: 'count',
    definition: { numerator: 'listings that are live AND booking_eligible AND claimed (is_discovered = false, host_id set). Unclaimed candidates never count as inventory', denominator: null, window: 'point-in-time snapshot (ignores from/to)', source: 'listings' },
    requires: ['listings'],
    build: () => `SELECT count(*)::bigint AS value FROM listings WHERE status = 'live' AND booking_eligible = true AND is_discovered = false AND host_id IS NOT NULL`,
  },
  {
    key: 'unclaimed_candidates', section: 'acquisition', label: 'Unclaimed candidates (not inventory, now)', unit: 'count',
    definition: { numerator: 'listings still is_discovered = true. Shown for context only; excluded from every inventory number', denominator: null, window: 'point-in-time snapshot (ignores from/to)', source: 'listings.is_discovered' },
    requires: ['listings'],
    build: () => `SELECT count(*)::bigint AS value FROM listings WHERE is_discovered = true`,
  },

  // ---------------- guest funnel ----------------
  {
    key: 'listing_views', section: 'funnel', label: 'Listing views', unit: 'count',
    definition: { numerator: 'rows in listing_views created in the window', denominator: null, window: 'created_at in [from, to)', source: 'listing_views (no such event source exists yet: null until it does)' },
    requires: ['listing_views'],
    build: () => count('listing_views', 'created_at'),
  },
  {
    key: 'inquiries', section: 'funnel', label: 'Inquiries', unit: 'count',
    definition: { numerator: 'inquiries created in the window', denominator: null, window: W, source: 'inquiries' },
    requires: ['inquiries'],
    build: () => count('inquiries', 'created_at'),
  },
  {
    key: 'host_responses', section: 'funnel', label: 'Host responses', unit: 'count',
    definition: { numerator: 'inquiries whose first_response_at is in the window', denominator: null, window: 'first_response_at in [from, to)', source: 'inquiries.first_response_at' },
    requires: ['inquiries'],
    build: () => count('inquiries', 'first_response_at'),
  },
  {
    key: 'offers_sent', section: 'funnel', label: 'Offers sent', unit: 'count',
    definition: { numerator: 'booking_offers created in the window', denominator: null, window: W, source: 'booking_offers' },
    requires: ['booking_offers'],
    build: () => count('booking_offers', 'created_at'),
  },
  {
    key: 'offers_accepted', section: 'funnel', label: 'Offers accepted', unit: 'count',
    definition: { numerator: 'booking_offers accepted in the window', denominator: null, window: 'accepted_at in [from, to)', source: 'booking_offers.accepted_at' },
    requires: ['booking_offers'],
    build: () => count('booking_offers', 'accepted_at'),
  },
  {
    key: 'bookings_requested', section: 'funnel', label: 'Bookings created', unit: 'count',
    definition: { numerator: 'bookings created in the window', denominator: null, window: W, source: 'bookings' },
    requires: ['bookings'],
    build: () => count('bookings', 'created_at'),
  },
  {
    key: 'bookings_confirmed', section: 'funnel', label: 'Bookings confirmed', unit: 'count',
    definition: { numerator: `bookings created in the window now in status ${BOOKING_CONFIRMED_PLUS}`, denominator: null, window: W, source: 'bookings.status' },
    requires: ['bookings'],
    build: () => count('bookings', 'created_at', `AND status IN ${BOOKING_CONFIRMED_PLUS}`),
  },
  {
    key: 'bookings_completed', section: 'funnel', label: 'Bookings completed', unit: 'count',
    definition: { numerator: `bookings created in the window now in status completed`, denominator: null, window: W, source: 'bookings.status' },
    requires: ['bookings'],
    build: () => count('bookings', 'created_at', `AND status = 'completed'`),
  },

  // ---------------- finance ----------------
  {
    key: 'gmv', section: 'finance', label: 'GMV', unit: 'rupees',
    definition: { numerator: `sum(payments.amount) for payments actually collected (status held, released_to_host, split or refunded)`, denominator: null, window: 'coalesce(paid_at, created_at) in [from, to)', source: 'payments' },
    requires: ['payments'],
    build: () => `SELECT coalesce(sum(amount),0)::bigint AS value FROM payments
                   WHERE status IN ('held','released_to_host','split','refunded') AND coalesce(paid_at, created_at) >= $1 AND coalesce(paid_at, created_at) < $2`,
  },
  {
    key: 'gross_commission', section: 'finance', label: 'Gross commission', unit: 'rupees',
    definition: { numerator: 'sum(credit - debit) on ledger account platform_commission', denominator: null, window: 'ledger_entries.created_at in [from, to)', source: 'ledger_entries' },
    requires: ['ledger_entries'],
    build: () => `SELECT coalesce(sum(credit - debit),0)::bigint AS value FROM ledger_entries WHERE account = 'platform_commission' AND created_at >= $1 AND created_at < $2`,
  },
  {
    key: 'net_realised_commission', section: 'finance', label: 'Net realised commission', unit: 'rupees',
    definition: { numerator: 'gross commission in the window excluding payments that have a settled refund (refund_settled ledger kind)', denominator: null, window: 'ledger_entries.created_at in [from, to)', source: 'ledger_entries' },
    requires: ['ledger_entries'],
    build: () => `SELECT coalesce(sum(e.credit - e.debit),0)::bigint AS value FROM ledger_entries e
                   WHERE e.account = 'platform_commission' AND e.created_at >= $1 AND e.created_at < $2
                     AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.kind = 'refund_settled' AND r.payment_id = e.payment_id)`,
  },
  {
    key: 'refunds', section: 'finance', label: 'Refunds settled', unit: 'rupees',
    definition: { numerator: 'sum(debit) on ledger account refunds for kind refund_settled', denominator: null, window: 'ledger_entries.created_at in [from, to)', source: 'ledger_entries' },
    requires: ['ledger_entries'],
    build: () => `SELECT coalesce(sum(debit),0)::bigint AS value FROM ledger_entries WHERE kind = 'refund_settled' AND account = 'refunds' AND created_at >= $1 AND created_at < $2`,
  },
  {
    key: 'pending_host_payables', section: 'finance', label: 'Pending host payables (now)', unit: 'rupees',
    definition: { numerator: 'sum(credit - debit) on ledger account host_payable: owed to hosts and not yet paid out', denominator: null, window: 'point-in-time balance (ignores from/to)', source: 'ledger_entries' },
    requires: ['ledger_entries'],
    build: () => `SELECT coalesce(sum(credit - debit),0)::bigint AS value FROM ledger_entries WHERE account = 'host_payable'`,
  },
  {
    key: 'settled_payouts', section: 'finance', label: 'Settled payouts', unit: 'rupees',
    definition: { numerator: 'sum(payouts.amount) with state paid', denominator: null, window: 'paid_at in [from, to)', source: 'payouts' },
    requires: ['payouts'],
    build: () => `SELECT coalesce(sum(amount),0)::bigint AS value FROM payouts WHERE state = 'paid' AND paid_at >= $1 AND paid_at < $2`,
  },

  // ---------------- operational ----------------
  {
    key: 'inquiry_response_time_hours', section: 'operations', label: 'Inquiry response time', unit: 'hours',
    definition: { numerator: 'mean of (first_response_at - created_at) in hours; detail.medianHours is the median', denominator: 'inquiries created in the window that have a first response', window: W, source: 'inquiries' },
    requires: ['inquiries'],
    build: () => `SELECT avg(extract(epoch FROM (first_response_at - created_at)) / 3600.0)::float AS value,
                         count(*)::bigint AS denominator,
                         jsonb_build_object('medianHours', percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (first_response_at - created_at)) / 3600.0)) AS detail
                    FROM inquiries WHERE first_response_at IS NOT NULL AND created_at >= $1 AND created_at < $2`,
  },
  {
    key: 'host_verification_time_hours', section: 'operations', label: 'Host verification time', unit: 'hours',
    definition: { numerator: 'mean of (reviewed_at - submitted_at) in hours', denominator: 'verification cases reviewed in the window', window: 'reviewed_at in [from, to)', source: 'host_verification_cases' },
    requires: ['host_verification_cases'],
    build: () => `SELECT avg(extract(epoch FROM (reviewed_at - submitted_at)) / 3600.0)::float AS value, count(*)::bigint AS denominator
                    FROM host_verification_cases WHERE submitted_at IS NOT NULL AND reviewed_at >= $1 AND reviewed_at < $2`,
  },
  {
    key: 'booking_conversion_rate', section: 'operations', label: 'Booking conversion', unit: 'ratio',
    definition: { numerator: `bookings created in the window now in status ${BOOKING_CONFIRMED_PLUS}`, denominator: 'all bookings created in the window', window: W, source: 'bookings' },
    requires: ['bookings'],
    build: () => `SELECT count(*) FILTER (WHERE status IN ${BOOKING_CONFIRMED_PLUS})::bigint AS numerator, count(*)::bigint AS denominator,
                         (count(*) FILTER (WHERE status IN ${BOOKING_CONFIRMED_PLUS}))::float / nullif(count(*),0) AS value
                    FROM bookings WHERE created_at >= $1 AND created_at < $2`,
  },
  {
    key: 'cancellation_rate', section: 'operations', label: 'Cancellation rate', unit: 'ratio',
    definition: { numerator: 'bookings created in the window now cancelled', denominator: 'bookings created in the window that reached confirmed or beyond, or were cancelled', window: W, source: 'bookings' },
    requires: ['bookings'],
    build: () => `SELECT count(*) FILTER (WHERE status = 'cancelled')::bigint AS numerator,
                         count(*) FILTER (WHERE status IN ${BOOKING_CONFIRMED_PLUS} OR status = 'cancelled')::bigint AS denominator,
                         (count(*) FILTER (WHERE status = 'cancelled'))::float / nullif(count(*) FILTER (WHERE status IN ${BOOKING_CONFIRMED_PLUS} OR status = 'cancelled'),0) AS value
                    FROM bookings WHERE created_at >= $1 AND created_at < $2`,
  },
  {
    key: 'failed_payment_rate', section: 'operations', label: 'Failed payment rate', unit: 'ratio',
    definition: { numerator: 'payments created in the window with status failed', denominator: 'payments created in the window that are no longer pending (settled or failed)', window: W, source: 'payments' },
    requires: ['payments'],
    build: () => `SELECT count(*) FILTER (WHERE status = 'failed')::bigint AS numerator,
                         count(*) FILTER (WHERE status <> 'pending')::bigint AS denominator,
                         (count(*) FILTER (WHERE status = 'failed'))::float / nullif(count(*) FILTER (WHERE status <> 'pending'),0) AS value
                    FROM payments WHERE created_at >= $1 AND created_at < $2`,
  },
  {
    key: 'acquisition_cost_per_activated_host', section: 'operations', label: 'Acquisition cost per activated host', unit: 'rupees',
    definition: { numerator: 'sum(acquisition_costs.amount_rupees) for periods (YYYY-MM, UTC) from the month of `from` to the month of `to`; null when no cost rows exist', denominator: 'distinct claimants with a claim APPROVED in the window (an activated host)', window: 'cost periods overlapping the window; claims decided_at in [from, to)', source: 'acquisition_costs (manual input) + property_claims' },
    requires: ['acquisition_costs', 'property_claims'],
    build: () => `WITH c AS (SELECT sum(amount_rupees)::bigint AS amt FROM acquisition_costs
                              WHERE period >= to_char($1::timestamptz AT TIME ZONE 'UTC','YYYY-MM') AND period <= to_char(($2::timestamptz - interval '1 second') AT TIME ZONE 'UTC','YYYY-MM')),
                      h AS (SELECT count(DISTINCT claimant_user_id)::bigint AS n FROM property_claims WHERE state = 'APPROVED' AND decided_at >= $1 AND decided_at < $2)
                 SELECT c.amt AS numerator, h.n AS denominator,
                        CASE WHEN c.amt IS NULL OR h.n = 0 THEN NULL ELSE c.amt::float / h.n END AS value FROM c, h`,
  },
];

export const SECTIONS: Section[] = ['acquisition', 'funnel', 'finance', 'operations'];
export const metricsFor = (section: Section): MetricSpec[] => METRICS.filter((m) => m.section === section);

const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Row (as returned by pg) -> MetricResult. bigint strings become numbers; an absent value stays null. */
export function toResult(spec: MetricSpec, row: Record<string, unknown> | undefined): MetricResult {
  const r: MetricResult = { key: spec.key, label: spec.label, unit: spec.unit, value: toNum(row?.value) };
  if (row && 'numerator' in row) r.numerator = toNum(row.numerator);
  if (row && 'denominator' in row) r.denominator = toNum(row.denominator);
  if (row?.detail !== undefined && row.detail !== null) r.detail = row.detail;
  return r;
}

export const unavailable = (spec: MetricSpec, why: 'missing_tables' | 'error', missingTables?: string[]): MetricResult => ({
  key: spec.key, label: spec.label, unit: spec.unit, value: null, unavailable: why, ...(missingTables ? { missingTables } : {}),
});
