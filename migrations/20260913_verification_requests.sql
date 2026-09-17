-- ============================================================
-- Verification request lifecycle: identity / pan / bank
--
-- ONE normalized table for all three verification types via the
-- `verification_type` discriminator, rather than three near-duplicate
-- tables. A row only exists once a user has actually submitted something
-- — there is no "not_started" status: the absence of any row for a given
-- (user_id, verification_type) IS "not started". The MOST RECENT row per
-- (user_id, verification_type) (order by submitted_at desc, or updated_at
-- desc) is always the current status; older rows are resubmission history
-- and are deliberately kept, not overwritten — see the note on the
-- (user_id, verification_type) index below for why there is no unique
-- constraint there.
--
-- Banking here reuses profiles.bank_upi / profiles.bank_account_name
-- (added in 20260902_profile_verification.sql) for the UPI/name identity
-- check already in place — this table only adds the genuinely new bank
-- fields that schema does not have: account number, IFSC, and bank name,
-- needed for the new document-backed bank verification flow.
--
-- Once this lifecycle is live, profiles.kyc_completed_at /
-- selfie_uploaded_at / bank_verified_at should only be written when an
-- ADMIN approves the corresponding verification_requests row (not on
-- user submit) — see src/user/verification-gate.util.ts, which keeps
-- reading those same columns unchanged.
--
-- Idempotent — safe to re-run.
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists verification_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,

  -- "identity" | "pan" | "bank"
  verification_type text not null,

  -- Only populated for verification_type = 'identity':
  -- "aadhaar" | "passport" | "driving_licence". Null for pan/bank.
  document_subtype text,

  -- "pending" | "verified" | "rejected". Default 'pending' because a row
  -- is only ever inserted on submit — there is no "not_started" value;
  -- that state is represented by no row existing yet for this
  -- (user_id, verification_type).
  status text not null default 'pending',

  -- Storage path in the private "verification-documents" bucket
  -- (shape: {userId}/{verificationType}/{randomUUID()}.{ext}). Nullable
  -- because a bank verification submission may carry only account
  -- details with no supporting document.
  document_path text,

  -- Bank-specific fields, only used when verification_type = 'bank'.
  -- UPI/account-holder-name identity checks stay on profiles
  -- (bank_upi, bank_account_name) — these are the new fields that table
  -- does not have.
  bank_account_number text,
  bank_ifsc text,
  bank_account_holder_name text,
  bank_name text,

  -- Output of DocumentAnalysisService (see
  -- src/verification/document-analysis.service.ts) — structural/quality
  -- signals only, never extracted sensitive field values.
  analysis_result jsonb,

  -- Required by app logic (not enforced at the DB level) whenever
  -- status = 'rejected'.
  rejection_reason text,

  reviewed_by uuid references profiles(id),
  reviewed_at timestamptz,

  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Admin "my queue" / user "my submissions" lookups by owner.
create index if not exists idx_verification_requests_user_id
  on verification_requests (user_id);

-- Admin review queue filtering (e.g. "show all pending requests").
create index if not exists idx_verification_requests_status
  on verification_requests (status);

-- Admin dashboards segmenting counts/queues by type (identity vs pan vs bank).
create index if not exists idx_verification_requests_verification_type
  on verification_requests (verification_type);

-- The hot path: "what is this user's current status for this
-- verification type" — fetch the most recent row for
-- (user_id, verification_type). Deliberately NOT a unique constraint:
-- a user can have a rejected row followed by a new pending row on
-- resubmission, and that history must be preserved, so multiple rows
-- per (user_id, verification_type) are allowed by design.
create index if not exists idx_verification_requests_user_type
  on verification_requests (user_id, verification_type);

-- ============================================================
-- Append-only audit trail. Metadata only — action/status/reason — NEVER
-- document contents, bytes, or extracted sensitive fields (PAN/aadhaar
-- numbers, account numbers, etc).
-- ============================================================
create table if not exists verification_audit_log (
  id uuid primary key default gen_random_uuid(),
  verification_request_id uuid references verification_requests(id) on delete cascade,
  user_id uuid not null,
  admin_id uuid references profiles(id),

  -- "submitted" | "approved" | "rejected" | "resubmitted"
  action text not null,

  previous_status text,
  new_status text,
  rejection_reason text,

  created_at timestamptz not null default now()
);

-- Rendering the full history for one verification_requests row.
create index if not exists idx_verification_audit_log_request_id
  on verification_audit_log (verification_request_id);

-- Rendering a user's full verification activity across all their requests.
create index if not exists idx_verification_audit_log_user_id
  on verification_audit_log (user_id);
