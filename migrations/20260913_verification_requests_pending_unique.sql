-- ============================================================
-- Closes a race in VerificationService.assertCanSubmit(): that check reads
-- the latest row and only later inserts a new one, with no transaction or
-- lock between the two — two concurrent submit requests for the same
-- (user_id, verification_type) (double-click past a disabled button, two
-- tabs, etc.) can both pass the "no pending/verified row yet" check and
-- both insert a 'pending' row.
--
-- A single 'pending' row per (user_id, verification_type) is the actual
-- invariant the state machine assumes (see verification.service.ts's
-- comment on assertCanSubmit and migrations/20260913_verification_requests.sql,
-- which explains why there is NO unique constraint on the (user_id,
-- verification_type) pair in general — full resubmission history is kept,
-- and 'rejected' rows especially must stay multiple). A partial unique
-- index scoped to status = 'pending' preserves all of that: any number of
-- 'rejected'/'verified' rows for the same pair are still allowed, only two
-- simultaneously-'pending' rows for the same pair are not. The loser of a
-- race now gets a Postgres unique-violation instead of a silently-created
-- duplicate pending row; VerificationService maps that to a 409 the same
-- way assertCanSubmit's normal check does.
--
-- Idempotent — safe to re-run.
-- ============================================================

create unique index if not exists idx_verification_requests_one_pending_per_user_type
  on verification_requests (user_id, verification_type)
  where status = 'pending';
