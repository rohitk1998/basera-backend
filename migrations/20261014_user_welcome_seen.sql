-- First-visit welcome dialog: users.welcome_seen_at
-- NULL = the account has not seen the home-page welcome yet. Set once (never
-- overwritten) by POST /api/user/welcome-seen.
-- Existing rows stay NULL, so every existing account sees the welcome once on
-- its next home visit. To show it only to new accounts instead, run this
-- optional backfill after the alter:
-- update users set welcome_seen_at = now() where welcome_seen_at is null;
-- Idempotent - safe to re-run. Until applied, the endpoint swallows the
-- missing-column error and still returns success.
alter table if exists users add column if not exists welcome_seen_at timestamptz;
