-- ============================================================
-- Unique constraint on profiles.email
-- Run this against the Supabase Postgres instance.
--
-- Backs the email+password signup flow's uniqueness rule (see
-- AuthController.signup): an email may only ever belong to one
-- profile, whether that profile was created via phone-OTP or via
-- signup(). NULL values are unaffected — Postgres unique constraints
-- don't compare NULLs to each other, so accounts with no email on
-- file (most phone-OTP-only accounts) are untouched.
--
-- Verified before writing this migration: zero duplicate emails
-- existed in the real table at the time this was applied.
--
-- Idempotent — safe to re-run.
-- ============================================================

alter table profiles
  drop constraint if exists profiles_email_key;

alter table profiles
  add constraint profiles_email_key unique (email);
