-- ============================================================
-- Account-level verification: selfie + banking
--
-- Verification now gates the first consequential action for EVERY
-- account, not just hosts — guest checkout (request to book) and
-- host listing publish both read the same fields off `profiles`:
-- kyc_completed_at (host-only), selfie_uploaded_at, bank_verified_at.
-- See src/user/verification-gate.util.ts for the shared check, wired
-- into host-listings.service.ts submitFull() and bookings.service.ts
-- create().
--
-- Banking here is IDENTITY proof ("does this person's bank account
-- carry their real name"), a different concept from a listing's
-- payout destination (draft_data.banking on `listings`, untouched by
-- this migration) — a host may legitimately route different listings'
-- rent to different accounts, so the two stay separate columns.
--
-- Idempotent — safe to re-run.
-- ============================================================

alter table profiles
  add column if not exists selfie_url text,
  add column if not exists selfie_uploaded_at timestamptz,
  add column if not exists bank_upi text,
  add column if not exists bank_account_name text,
  add column if not exists bank_verified_at timestamptz;

-- Grandfather ONLY banking for existing verified hosts, backfilled from
-- their most recent real listing submission — a genuine value that
-- already passed the (mocked) penny-drop check, just in the wrong scope.
--
-- Selfie is deliberately NOT backfilled: it was always a UI-only
-- checkbox, never a real capture, so there is no genuine value to
-- promote. Existing hosts keep their current listings live but must
-- complete a real selfie before their next submit/resubmit.
update profiles p
set
  bank_upi = coalesce(p.bank_upi, l.upi),
  bank_account_name = coalesce(p.bank_account_name, l.acct_name),
  bank_verified_at = coalesce(p.bank_verified_at, p.kyc_completed_at)
from (
  select distinct on (host_id)
    host_id,
    draft_data->'banking'->>'upi' as upi,
    draft_data->'banking'->>'name' as acct_name
  from listings
  where draft_data->'banking' is not null
  order by host_id, created_at desc
) l
where p.id = l.host_id
  and p.kyc_completed_at is not null
  and p.bank_verified_at is null;
