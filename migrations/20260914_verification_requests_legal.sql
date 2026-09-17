-- ============================================================
-- Extends verification_requests (see 20260913_verification_requests.sql)
-- to cover a fourth verification_type: 'legal' — the HP Tourism Home Stay
-- registration certificate + registration number, moving it from
-- self-attested (profiles.registration_number, written instantly with no
-- review by POST /api/user/kyc) onto the same reviewed
-- pending -> verified/rejected lifecycle as identity/pan/bank.
--
-- profiles.registration_number / kyc_completed_at are left untouched here:
-- they remain the source of truth the rest of the app already reads
-- (assertVerified's requireHostKyc branch, host-listings submit gate).
-- The new verification_requests row is what an admin actually reviews;
-- approval is expected to also stamp those profile columns (see the
-- accompanying admin.service.ts change), same as bank approval already
-- flips profiles.bank_verified_at.
--
-- Idempotent — safe to re-run.
-- ============================================================

alter table verification_requests
  add column if not exists registration_number text;

comment on column verification_requests.registration_number is
  'HP Tourism registration number (format HP/HS/1234/2025), only used when verification_type = ''legal''. The certificate document itself rides in document_path, same private-bucket convention as every other verification type.';
