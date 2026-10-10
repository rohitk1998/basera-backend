-- ============================================================
-- Removes the "legal" (HP Tourism Home Stay registration) verification
-- layer entirely. It is no longer submittable (verification_type = 'legal'
-- is gone from the app), never reviewed, and no longer gates host listing
-- publish (assertVerified's requireHostKyc branch was removed — hosts now
-- publish once selfie + bank verification pass, same as guests).
--
-- Any existing verification_requests rows with verification_type = 'legal'
-- are deleted first (their FK-less audit log rows point at the request id
-- and are deleted via the same filter) since the column that made them
-- meaningful is being dropped.
--
-- Idempotent — safe to re-run.
-- ============================================================

delete from verification_audit_log
  where verification_request_id in (
    select id from verification_requests where verification_type = 'legal'
  );

delete from verification_requests where verification_type = 'legal';

alter table verification_requests
  drop column if exists registration_number;

alter table users
  drop column if exists registration_number;

alter table users
  drop column if exists kyc_completed_at;

-- 'legal' is no longer a valid review_reason_category (see
-- 20260822_review_reason_category.sql) — reclassify any existing rows
-- before tightening the check constraint, or the ALTER fails.
update listings
  set review_reason_category = 'other'
  where review_reason_category = 'legal';

alter table listings
  drop constraint if exists listings_review_reason_category_check;

alter table listings
  add constraint listings_review_reason_category_check
  check (
    review_reason_category is null
    or review_reason_category in ('telemetry', 'banking', 'listing_content', 'other')
  );
