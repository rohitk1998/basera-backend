-- Adds refresh-token storage so a session can be silently renewed instead of
-- hard-logging the user out after the 7-day access token expires. The raw
-- token is never stored — only its SHA-256 hash, same pattern as
-- password_hash but for a token that lives in an httpOnly cookie rather than
-- a user-supplied secret.
alter table if exists users
  add column if not exists refresh_token_hash text,
  add column if not exists refresh_token_expires_at timestamptz;
