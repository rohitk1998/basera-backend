-- ============================================================
-- Admin password login
-- Run this against the Supabase Postgres instance (same DB the
-- Next.js app's supabase/migrations/*.sql files targeted).
--
-- Every guest/host account authenticates via Firebase phone-OTP
-- (see basera-backend/src/auth/auth.controller.ts) and has no
-- password. Admins are the one exception: role = 'admin' is already
-- manually provisioned via direct SQL (see profiles.role in
-- ProfileEntity), so a password credential for that same manually-
-- provisioned account is consistent with how admin access already
-- works here — not a new signup path, just a new login path for an
-- account that only ever existed by hand in the first place.
--
-- Idempotent — safe to re-run.
-- ============================================================

alter table profiles
  add column if not exists password_hash text;

-- No CHECK constraint tying password_hash to role = 'admin': enforcement
-- lives in the application (AdminLoginService only ever writes/reads this
-- column for admin accounts), matching how role itself has no CHECK either.
