-- ============================================================
-- Profile locale preference
-- Run this against the Supabase Postgres instance (same DB the
-- Next.js app's supabase/migrations/*.sql files targeted).
--
-- The web app already resolves a locale per-request via the
-- NEXT_LOCALE cookie, but that's invisible to the backend when it
-- sends an async push notification (no active request/cookie in
-- scope at notify() time). This column is what a logged-in user's
-- locale choice syncs to, so notification-sending code has
-- something to look up. NULL means "never set" — falls back to
-- English, same as an unset cookie does on the frontend.
--
-- Idempotent — safe to re-run.
-- ============================================================

alter table profiles
  add column if not exists preferred_locale text;
