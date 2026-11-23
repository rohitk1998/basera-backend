import { ageBucket, fixedBucket, minThreshold } from './automation.buckets';
import type { AutomationDef, AutomationParams, CandidateRow, ParamSpec } from './automation.types';

const TITLE = `l.draft_data->'property_details'->>'title'`;
/** India Standard Time calendar day of `now` ($1). Check-in/out dates are local calendar dates. */
const TODAY_IST = `(($1::timestamptz) AT TIME ZONE 'Asia/Kolkata')::date`;
const LIMIT = 500;

const thresholds = (def: number[]): { p: number[]; spec: ParamSpec } => ({
  p: def,
  spec: { type: 'intArray', min: 1, max: 24 * 60, minLen: 1, maxLen: 5 },
});
const hoursSpec: ParamSpec = { type: 'int', min: 1, max: 24 * 60 };
const whatsappSpec: ParamSpec = { type: 'bool' };

const arr = (params: AutomationParams, key: string): number[] => params[key] as number[];
const num = (params: AutomationParams, key: string): number => params[key] as number;
const fallbackTitle = (r: CandidateRow) => (r.title && String(r.title).trim()) || 'your property';
const linkOf = (appUrl: string, path: string) => `${appUrl.replace(/\/$/, '')}${path}`;

/** Age-bucketed definition factory: fires once per crossed threshold. */
function aged(def: Omit<AutomationDef, 'bucket' | 'defaultParams' | 'paramSpec'> & {
  thresholds: number[];
  extraParams?: AutomationParams;
  extraSpec?: Record<string, ParamSpec>;
}): AutomationDef {
  const t = thresholds(def.thresholds);
  const { thresholds: _t, extraParams, extraSpec, ...rest } = def;
  return {
    ...rest,
    defaultParams: { thresholdsHours: t.p, maxPerRun: 200, ...(extraParams ?? {}) },
    paramSpec: { thresholdsHours: t.spec, maxPerRun: { type: 'int', min: 1, max: LIMIT }, ...(extraSpec ?? {}) },
    bucket: (row, params) => ageBucket(Number(row.age_hours), arr(params, 'thresholdsHours')),
  };
}

const AGE = (col: string) => `EXTRACT(EPOCH FROM ($1::timestamptz - ${col})) / 3600.0`;
const cap = (p: AutomationParams) => Math.min(num(p, 'maxPerRun') ?? 200, LIMIT);

export const AUTOMATIONS: AutomationDef[] = [
  // ---- claims -----------------------------------------------------------------------------------------------
  aged({
    kind: 'claim_draft_incomplete',
    title: 'Draft claim not completed',
    description: 'Claimant started a property claim (DRAFT) but has not submitted it. Reminds the claimant.',
    audience: 'user',
    subjectType: 'property_claim',
    event: 'claim.draft_reminder',
    requires: ['property_claims', 'listings', 'users'],
    thresholds: [72, 168],
    extraParams: { whatsapp: true },
    extraSpec: { whatsapp: whatsappSpec },
    query: (p) => ({
      sql: `SELECT c.id::text AS subject_id, c.claimant_user_id::text AS user_id, ${TITLE} AS title, u.phone, u.full_name AS name,
                   ${AGE('c.updated_at')} AS age_hours
              FROM property_claims c
              JOIN listings l ON l.id = c.listing_id
              LEFT JOIN users u ON u.id = c.claimant_user_id
             WHERE c.state = 'DRAFT' AND c.updated_at <= $1::timestamptz - make_interval(hours => $2::int)
             ORDER BY c.updated_at LIMIT ${cap(p)}`,
      args: [minThreshold(arr(p, 'thresholdsHours'))],
    }),
    data: (r, _p, appUrl) => ({
      listingTitle: fallbackTitle(r),
      link: `/claim/${r.subject_id}`,
      pushTitle: 'Finish your property claim',
      pushBody: `Your claim for ${fallbackTitle(r)} is still a draft. Submit it to get verified.`,
      absoluteLink: linkOf(appUrl, `/claim/${r.subject_id}`),
    }),
    whatsapp: (r, p, appUrl) =>
      p.whatsapp && r.phone
        ? { template: 'claim_reminder', params: { host_name: String(r.name ?? 'there'), claim_url: linkOf(appUrl, `/claim/${r.subject_id}`) } }
        : null,
  }),
  aged({
    kind: 'claim_more_info',
    title: 'Claim waiting on more information',
    description: 'Claim is MORE_INFORMATION_REQUIRED and the claimant has not responded. Reminds the claimant.',
    audience: 'user',
    subjectType: 'property_claim',
    event: 'claim.more_info_reminder',
    requires: ['property_claims', 'listings', 'users'],
    thresholds: [48, 120],
    extraParams: { whatsapp: true },
    extraSpec: { whatsapp: whatsappSpec },
    query: (p) => ({
      sql: `SELECT c.id::text AS subject_id, c.claimant_user_id::text AS user_id, ${TITLE} AS title, u.phone, u.full_name AS name,
                   ${AGE('c.updated_at')} AS age_hours
              FROM property_claims c
              JOIN listings l ON l.id = c.listing_id
              LEFT JOIN users u ON u.id = c.claimant_user_id
             WHERE c.state = 'MORE_INFORMATION_REQUIRED' AND c.updated_at <= $1::timestamptz - make_interval(hours => $2::int)
             ORDER BY c.updated_at LIMIT ${cap(p)}`,
      args: [minThreshold(arr(p, 'thresholdsHours'))],
    }),
    data: (r) => ({
      listingTitle: fallbackTitle(r),
      link: `/claim/${r.subject_id}`,
      pushTitle: 'We need more information',
      pushBody: `Your claim for ${fallbackTitle(r)} needs more information before we can review it.`,
    }),
    whatsapp: (r, p, appUrl) =>
      p.whatsapp && r.phone
        ? { template: 'claim_reminder', params: { host_name: String(r.name ?? 'there'), claim_url: linkOf(appUrl, `/claim/${r.subject_id}`) } }
        : null,
  }),
  aged({
    kind: 'claim_review_waiting',
    title: 'Submitted claim awaiting review',
    description: 'A submitted claim has waited for admin review. Alerts admins.',
    audience: 'admin',
    subjectType: 'property_claim',
    event: 'admin.claim_review_waiting',
    requires: ['property_claims', 'listings'],
    thresholds: [48, 96],
    query: (p) => ({
      sql: `SELECT c.id::text AS subject_id, NULL::text AS user_id, ${TITLE} AS title,
                   ${AGE('coalesce(c.submitted_at, c.updated_at)')} AS age_hours
              FROM property_claims c
              JOIN listings l ON l.id = c.listing_id
             WHERE c.state IN ('SUBMITTED','UNDER_REVIEW')
               AND coalesce(c.submitted_at, c.updated_at) <= $1::timestamptz - make_interval(hours => $2::int)
             ORDER BY c.submitted_at LIMIT ${cap(p)}`,
      args: [minThreshold(arr(p, 'thresholdsHours'))],
    }),
    data: (r) => ({
      listingTitle: fallbackTitle(r),
      link: '/admin?tab=claims',
      pushTitle: 'Claim waiting for review',
      pushBody: `Claim for ${fallbackTitle(r)} has been waiting ${Math.floor(Number(r.age_hours))}h.`,
    }),
  }),

  // ---- host onboarding --------------------------------------------------------------------------------------
  aged({
    kind: 'host_invited_not_onboarded',
    title: 'Invited host has not onboarded',
    description: 'CRM lead is INVITED 3/7 days later with no onboarding. Alerts the owning staff member (all admins when unowned).',
    audience: 'staff',
    subjectType: 'host_lead',
    event: 'admin.host_invite_stalled',
    requires: ['host_leads'],
    thresholds: [72, 168],
    query: (p) => ({
      sql: `SELECT h.id::text AS subject_id, h.owner_staff_id::text AS user_id,
                   coalesce(h.contact_name, h.property_hint) AS title,
                   ${AGE('h.invited_at')} AS age_hours
              FROM host_leads h
             WHERE h.contact_state = 'INVITED' AND h.invited_at IS NOT NULL
               AND h.invited_at <= $1::timestamptz - make_interval(hours => $2::int)
             ORDER BY h.invited_at LIMIT ${cap(p)}`,
      args: [minThreshold(arr(p, 'thresholdsHours'))],
    }),
    data: (r) => ({
      listingTitle: fallbackTitle(r),
      link: '/admin?tab=crm',
      pushTitle: 'Invited host has not onboarded',
      pushBody: `${fallbackTitle(r)} was invited ${Math.floor(Number(r.age_hours) / 24)} days ago. Follow up.`,
    }),
  }),
  aged({
    kind: 'host_listing_draft_incomplete',
    title: 'Listing draft not finished',
    description: 'A host has an unfinished listing draft. Reminds the host.',
    audience: 'user',
    subjectType: 'listing',
    event: 'host.listing_draft_reminder',
    requires: ['listings'],
    thresholds: [72, 168],
    query: (p) => ({
      sql: `SELECT l.id::text AS subject_id, l.host_id::text AS user_id, ${TITLE} AS title,
                   ${AGE('coalesce(l.updated_at, l.created_at)')} AS age_hours
              FROM listings l
             WHERE l.status = 'draft' AND l.is_discovered = false AND l.host_id IS NOT NULL
               AND coalesce(l.updated_at, l.created_at) <= $1::timestamptz - make_interval(hours => $2::int)
             ORDER BY coalesce(l.updated_at, l.created_at) LIMIT ${cap(p)}`,
      args: [minThreshold(arr(p, 'thresholdsHours'))],
    }),
    data: (r) => ({
      listingTitle: fallbackTitle(r),
      link: '/host/start',
      pushTitle: 'Finish your listing',
      pushBody: `${fallbackTitle(r)} is almost ready. Complete it to go live.`,
    }),
  }),

  // ---- verification -----------------------------------------------------------------------------------------
  aged({
    kind: 'verification_review_alert',
    title: 'Verification case unresolved',
    description: 'A host verification case was submitted and is still unresolved after 24h. Alerts admins.',
    audience: 'admin',
    subjectType: 'host_verification_case',
    event: 'admin.verification_overdue',
    requires: ['host_verification_cases'],
    thresholds: [24, 72],
    query: (p) => ({
      sql: `SELECT v.id::text AS subject_id, NULL::text AS user_id, ${AGE('v.submitted_at')} AS age_hours
              FROM host_verification_cases v
             WHERE v.status = 'submitted' AND v.submitted_at IS NOT NULL
               AND v.submitted_at <= $1::timestamptz - make_interval(hours => $2::int)
             ORDER BY v.submitted_at LIMIT ${cap(p)}`,
      args: [minThreshold(arr(p, 'thresholdsHours'))],
    }),
    data: (r) => ({
      link: '/admin?tab=idcheck',
      pushTitle: 'Verification awaiting review',
      pushBody: `A host verification has been waiting ${Math.floor(Number(r.age_hours))}h.`,
    }),
  }),

  // ---- inquiries --------------------------------------------------------------------------------------------
  aged({
    kind: 'inquiry_unassigned',
    title: 'New inquiry unassigned',
    description: 'A NEW inquiry has no assignee after 2h/24h. Alerts admins.',
    audience: 'admin',
    subjectType: 'inquiry',
    event: 'admin.inquiry_unassigned',
    requires: ['inquiries'],
    thresholds: [2, 24],
    query: (p) => ({
      sql: `SELECT i.id::text AS subject_id, NULL::text AS user_id, i.destination AS title, ${AGE('i.created_at')} AS age_hours
              FROM inquiries i
             WHERE i.state = 'NEW' AND i.assigned_to IS NULL
               AND i.created_at <= $1::timestamptz - make_interval(hours => $2::int)
             ORDER BY i.created_at LIMIT ${cap(p)}`,
      args: [minThreshold(arr(p, 'thresholdsHours'))],
    }),
    data: (r) => ({
      link: '/admin?tab=inquiries',
      pushTitle: 'Inquiry needs an owner',
      pushBody: `An inquiry has been unassigned for ${Math.floor(Number(r.age_hours))}h.`,
    }),
  }),
  {
    kind: 'inquiry_response_due',
    title: 'Inquiry response due soon',
    description: 'Response deadline is within the configured window and nobody has replied. Alerts the assignee (all admins when unassigned).',
    audience: 'staff',
    subjectType: 'inquiry',
    event: 'admin.inquiry_response_due',
    requires: ['inquiries'],
    defaultParams: { withinMinutes: 60, maxPerRun: 200 },
    paramSpec: { withinMinutes: { type: 'int', min: 5, max: 24 * 60 }, maxPerRun: { type: 'int', min: 1, max: LIMIT } },
    query: (p) => ({
      sql: `SELECT i.id::text AS subject_id, i.assigned_to::text AS user_id, i.destination AS title
              FROM inquiries i
             WHERE i.state IN ('NEW','ASSIGNED','HOST_CONTACTING') AND i.first_response_at IS NULL
               AND i.response_due_at > $1::timestamptz
               AND i.response_due_at <= $1::timestamptz + make_interval(mins => $2::int)
             ORDER BY i.response_due_at LIMIT ${cap(p)}`,
      args: [num(p, 'withinMinutes')],
    }),
    bucket: fixedBucket('due'),
    data: (r) => ({
      link: '/admin?tab=inquiries',
      pushTitle: 'Inquiry response due soon',
      pushBody: 'An inquiry is about to breach its response deadline.',
    }),
  },
  // ---- bookings (READ-ONLY on bookings) ---------------------------------------------------------------------
  {
    kind: 'booking_checkin_instructions',
    title: 'Check-in instructions',
    description: 'Confirmed booking whose check-in is tomorrow (IST). Sends the guest check-in instructions.',
    audience: 'user',
    subjectType: 'booking',
    event: 'booking.checkin_instructions',
    requires: ['bookings', 'listings'],
    defaultParams: { daysBefore: 1, maxPerRun: 200 },
    paramSpec: { daysBefore: { type: 'int', min: 1, max: 14 }, maxPerRun: { type: 'int', min: 1, max: LIMIT } },
    query: (p) => ({
      sql: `SELECT b.id::text AS subject_id, b.guest_id::text AS user_id, ${TITLE} AS title
              FROM bookings b JOIN listings l ON l.id = b.listing_id
             WHERE b.status = 'confirmed' AND b.move_in = ${TODAY_IST} + $2::int
             ORDER BY b.move_in LIMIT ${cap(p)}`,
      args: [num(p, 'daysBefore')],
    }),
    bucket: fixedBucket('checkin'),
    data: (r) => ({
      listingTitle: fallbackTitle(r),
      link: `/booking/${r.subject_id}`,
      pushTitle: 'Check-in tomorrow',
      pushBody: `Your stay at ${fallbackTitle(r)} starts tomorrow. Open your booking for check-in instructions.`,
    }),
  },
  {
    kind: 'booking_checkout_reminder',
    title: 'Checkout reminder',
    description: 'Guest is checked in and the checkout date is today (IST).',
    audience: 'user',
    subjectType: 'booking',
    event: 'booking.checkout_reminder',
    requires: ['bookings', 'listings'],
    defaultParams: { maxPerRun: 200 },
    paramSpec: { maxPerRun: { type: 'int', min: 1, max: LIMIT } },
    query: (p) => ({
      sql: `SELECT b.id::text AS subject_id, b.guest_id::text AS user_id, ${TITLE} AS title
              FROM bookings b JOIN listings l ON l.id = b.listing_id
             WHERE b.status = 'checked_in' AND coalesce(b.actual_move_out, b.move_out) = ${TODAY_IST}
             ORDER BY b.move_out LIMIT ${cap(p)}`,
      args: [],
    }),
    bucket: fixedBucket('checkout'),
    data: (r) => ({
      listingTitle: fallbackTitle(r),
      link: `/booking/${r.subject_id}`,
      pushTitle: 'Checkout today',
      pushBody: `Your stay at ${fallbackTitle(r)} ends today. Please check out on time.`,
    }),
  },
  {
    kind: 'booking_review_request',
    title: 'Review request',
    description: 'Stay ended 2 days ago (7-day grace window) and the guest has not reviewed it.',
    audience: 'user',
    subjectType: 'booking',
    event: 'booking.review_request',
    requires: ['bookings', 'listings', 'reviews'],
    defaultParams: { daysAfter: 2, graceDays: 7, maxPerRun: 200 },
    paramSpec: {
      daysAfter: { type: 'int', min: 1, max: 30 },
      graceDays: { type: 'int', min: 0, max: 60 },
      maxPerRun: { type: 'int', min: 1, max: LIMIT },
    },
    query: (p) => ({
      sql: `SELECT b.id::text AS subject_id, b.guest_id::text AS user_id, ${TITLE} AS title
              FROM bookings b JOIN listings l ON l.id = b.listing_id
             WHERE b.status IN ('checked_out','completed')
               AND coalesce((b.checkout_time AT TIME ZONE 'Asia/Kolkata')::date, coalesce(b.actual_move_out, b.move_out))
                   BETWEEN ${TODAY_IST} - $2::int - $3::int AND ${TODAY_IST} - $2::int
               AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id)
             ORDER BY b.move_out DESC LIMIT ${cap(p)}`,
      args: [num(p, 'daysAfter'), num(p, 'graceDays')],
    }),
    bucket: fixedBucket('review'),
    data: (r) => ({
      listingTitle: fallbackTitle(r),
      link: `/booking/${r.subject_id}`,
      pushTitle: 'How was your stay?',
      pushBody: `Tell others about ${fallbackTitle(r)}. Leave a review.`,
    }),
  },
  {
    kind: 'payment_reminder',
    title: 'Payment reminder',
    description: 'Booking is awaiting payment and pay_by_at is within the configured window (default 6h). Reminds the guest.',
    audience: 'user',
    subjectType: 'booking',
    event: 'booking.payment_reminder',
    requires: ['bookings', 'listings', 'payments', 'users'],
    defaultParams: { hoursBefore: 6, whatsapp: true, maxPerRun: 200 },
    paramSpec: { hoursBefore: { type: 'int', min: 1, max: 72 }, whatsapp: whatsappSpec, maxPerRun: { type: 'int', min: 1, max: LIMIT } },
    query: (p) => ({
      sql: `SELECT b.id::text AS subject_id, b.guest_id::text AS user_id, ${TITLE} AS title, u.phone, u.full_name AS name
              FROM bookings b
              JOIN listings l ON l.id = b.listing_id
              LEFT JOIN users u ON u.id = b.guest_id
             WHERE b.status IN ('awaiting_payment','approved')
               AND b.pay_by_at IS NOT NULL AND b.pay_by_at > $1::timestamptz
               AND b.pay_by_at <= $1::timestamptz + make_interval(hours => $2::int)
               AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.status IN ('held','released_to_host','split'))
             ORDER BY b.pay_by_at LIMIT ${cap(p)}`,
      args: [num(p, 'hoursBefore')],
    }),
    bucket: fixedBucket('payby'),
    data: (r) => ({
      listingTitle: fallbackTitle(r),
      link: `/booking/${r.subject_id}`,
      pushTitle: 'Complete your payment',
      pushBody: `Pay soon to keep your booking at ${fallbackTitle(r)}.`,
    }),
    whatsapp: (r, p, appUrl) =>
      p.whatsapp && r.phone
        ? {
            template: 'payment_reminder',
            params: { guest_name: String(r.name ?? 'there'), listing_title: fallbackTitle(r), pay_url: linkOf(appUrl, `/booking/${r.subject_id}`) },
          }
        : null,
  },
  {
    kind: 'offer_expiring',
    title: 'Offer expiring',
    description: 'A pending host offer expires within the configured window. Reminds the guest. Skipped while booking_offers does not exist.',
    audience: 'user',
    subjectType: 'booking_offer',
    event: 'offer.expiring',
    requires: ['booking_offers', 'bookings', 'listings'],
    defaultParams: { hoursBefore: 6, maxPerRun: 200 },
    paramSpec: { hoursBefore: { type: 'int', min: 1, max: 72 }, maxPerRun: { type: 'int', min: 1, max: LIMIT } },
    query: (p) => ({
      sql: `SELECT o.id::text AS subject_id, b.guest_id::text AS user_id, ${TITLE} AS title, b.id::text AS booking_id
              FROM booking_offers o
              JOIN bookings b ON b.id = o.booking_id
              JOIN listings l ON l.id = b.listing_id
             WHERE o.state = 'pending' AND o.expires_at > $1::timestamptz
               AND o.expires_at <= $1::timestamptz + make_interval(hours => $2::int)
             ORDER BY o.expires_at LIMIT ${cap(p)}`,
      args: [num(p, 'hoursBefore')],
    }),
    bucket: fixedBucket('expiring'),
    data: (r) => ({
      listingTitle: fallbackTitle(r),
      link: `/booking/${r.booking_id}`,
      pushTitle: 'Your offer is expiring',
      pushBody: `The offer for ${fallbackTitle(r)} expires soon.`,
    }),
  },
];

export const AUTOMATION_KINDS = AUTOMATIONS.map((a) => a.kind);
export const getAutomation = (kind: string): AutomationDef | undefined => AUTOMATIONS.find((a) => a.kind === kind);

/** Validate+normalise tuned params against a definition's spec. Unknown keys are rejected. */
export function validateParams(def: AutomationDef, input: Record<string, unknown>): { ok: true; params: AutomationParams } | { ok: false; error: string } {
  const out: AutomationParams = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const spec = def.paramSpec[k];
    if (!spec) return { ok: false, error: `Unknown param "${k}" for ${def.kind}` };
    if (spec.type === 'bool') {
      if (typeof v !== 'boolean') return { ok: false, error: `${k} must be a boolean` };
      out[k] = v;
    } else if (spec.type === 'int') {
      if (!Number.isInteger(v) || (v as number) < spec.min || (v as number) > spec.max) return { ok: false, error: `${k} must be an integer in ${spec.min}..${spec.max}` };
      out[k] = v as number;
    } else {
      if (!Array.isArray(v) || v.length < spec.minLen || v.length > spec.maxLen || v.some((x) => !Number.isInteger(x) || x < spec.min || x > spec.max)) {
        return { ok: false, error: `${k} must be ${spec.minLen}-${spec.maxLen} integers in ${spec.min}..${spec.max}` };
      }
      out[k] = [...(v as number[])].sort((a, b) => a - b);
    }
  }
  return { ok: true, params: out };
}
