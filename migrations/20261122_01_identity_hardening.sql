-- Identity verification hardening. Idempotent; safe to re-run.

-- 1. Liveness nonce (server-issued at consent; the signed token is derived from it) and review fields.
ALTER TABLE host_verification_cases
  ADD COLUMN IF NOT EXISTS liveness_nonce text,
  ADD COLUMN IF NOT EXISTS duplicate_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS face_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS doc_dob date,               -- admin-entered from the ID, at approval
  ADD COLUMN IF NOT EXISTS doc_expiry date,            -- admin-entered from the ID, at approval (null for masked Aadhaar)
  ADD COLUMN IF NOT EXISTS adult_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS expiry_confirmed boolean NOT NULL DEFAULT false;

-- Admin queue: oldest-first within a status, plus per-user attempt counts.
CREATE INDEX IF NOT EXISTS hvc_status_submitted_idx
  ON host_verification_cases (status, submitted_at);
CREATE INDEX IF NOT EXISTS hvc_dup_hash_idx
  ON host_verification_cases (id_number_hash) WHERE id_number_hash IS NOT NULL;

-- 2. One account per identity: make the ID-hash index UNIQUE (partial).
--    Only done when no duplicates exist today; otherwise we leave the old index in place and
--    raise a notice, so the migration never fails or deletes data. De-duplicate by hand, re-run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users
     WHERE id_number_salted_hash IS NOT NULL
     GROUP BY id_number_salted_hash
    HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'users.id_number_salted_hash has duplicates: unique index NOT created. Resolve them and re-run this migration.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS users_id_number_hash_uniq
      ON users (id_number_salted_hash) WHERE id_number_salted_hash IS NOT NULL;
    DROP INDEX IF EXISTS users_id_number_hash_idx;
  END IF;
END $$;

-- hvc_one_open_per_user (user_id) WHERE status IN ('consented','submitted') already exists
-- (20261113_trust_pivot_foundation.sql); the service now treats its 23505 as "return the open case".
