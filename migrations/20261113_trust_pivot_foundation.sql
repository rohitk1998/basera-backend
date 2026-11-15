-- Trust pivot foundation: zero-ID guests, in-house host verify-and-purge.
-- Idempotent. NOT applied automatically: run it yourself, then restart the backend.
--
-- Guests: no ID stored anywhere. Contact gate = verified phone (Firebase) OR verified email (OTP).
-- Hosts:  raw ID / liveness frames live only in the private 'host-verification' bucket until an
--         admin decides, then they are deleted. Only is_id_verified + id_number_salted_hash stay.

-- ---------------------------------------------------------------- users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_id_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS id_number_salted_hash text,
  ADD COLUMN IF NOT EXISTS id_doc_type text,
  ADD COLUMN IF NOT EXISTS id_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS banned_at timestamptz;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_id_doc_type_check;
ALTER TABLE users ADD CONSTRAINT users_id_doc_type_check
  CHECK (id_doc_type IS NULL OR id_doc_type IN ('driving_license', 'voter_id', 'passport', 'aadhaar_masked'));

-- Accounts created through email OTP already proved the inbox.
UPDATE users SET email_verified_at = COALESCE(created_at, now())
 WHERE phone IS NULL AND email IS NOT NULL AND email_verified_at IS NULL;

-- Grandfather hosts/guests Didit already verified, so removing Didit does not lock anyone out.
-- (No hash exists for them: they cannot be matched against a ban list until they re-verify.)
UPDATE users u
   SET is_id_verified = true,
       id_verified_at = COALESCE(u.selfie_uploaded_at, now())
 WHERE u.is_id_verified = false
   AND u.selfie_uploaded_at IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM verification_requests v
      WHERE v.user_id = u.id AND v.verification_type = 'identity' AND v.status = 'verified'
   );

CREATE INDEX IF NOT EXISTS users_id_number_hash_idx
  ON users (id_number_salted_hash) WHERE id_number_salted_hash IS NOT NULL;

-- ---------------------------------------------------------------- bookings
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS id_disclaimer_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS id_disclaimer_version text,
  ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS guest_confirmed_stay_at timestamptz,
  ADD COLUMN IF NOT EXISTS host_confirmed_stay_at timestamptz,
  ADD COLUMN IF NOT EXISTS stay_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS stay_prompt_sent_at timestamptz;

-- Existing finished stays keep their reviews: treat them as confirmed.
UPDATE bookings SET stay_confirmed_at = COALESCE(checkout_time, now())
 WHERE status IN ('completed', 'checked_out') AND stay_confirmed_at IS NULL;

-- Open holds that existed before this change get a fresh 48h window.
UPDATE bookings SET hold_expires_at = now() + interval '48 hours'
 WHERE status = 'requested' AND hold_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS bookings_open_hold_idx ON bookings (guest_id) WHERE status = 'requested';
-- A UNIQUE version of this index is deliberately not created: existing data may already hold
-- several 'requested' rows per guest. The 1-active-hold rule is enforced in BookingsService.create.

-- ---------------------------------------------------------------- phone reveal log
CREATE TABLE IF NOT EXISTS phone_reveal_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id uuid NOT NULL,
  listing_id uuid NOT NULL,
  revealed_at timestamptz NOT NULL DEFAULT now(),
  ip_hash text
);
CREATE INDEX IF NOT EXISTS phone_reveal_logs_guest_time_idx ON phone_reveal_logs (guest_id, revealed_at DESC);
ALTER TABLE phone_reveal_logs ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- host verification cases
CREATE TABLE IF NOT EXISTS host_verification_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'consented'
    CHECK (status IN ('consented', 'submitted', 'approved', 'rejected', 'expired')),
  consent_version text NOT NULL,
  consent_at timestamptz NOT NULL,
  doc_type text CHECK (doc_type IS NULL OR doc_type IN ('driving_license', 'voter_id', 'passport', 'aadhaar_masked')),
  id_number_hash text,                 -- candidate hash, promoted to users.id_number_salted_hash on approval
  doc_path text,                       -- raw ID image, private bucket, deleted on decision
  liveness_paths text[],               -- 3 peak frames, deleted on decision
  challenges text[],                   -- e.g. {blink,turn_left}
  face_score real,                     -- cosine similarity (ID portrait vs live frames)
  face_status text NOT NULL DEFAULT 'pending'
    CHECK (face_status IN ('pending', 'scored', 'unavailable')),
  rejection_reason text,
  submitted_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  purged_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hvc_user_idx ON host_verification_cases (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hvc_status_idx ON host_verification_cases (status, submitted_at);
-- At most one case being worked on per user.
CREATE UNIQUE INDEX IF NOT EXISTS hvc_one_open_per_user
  ON host_verification_cases (user_id) WHERE status IN ('consented', 'submitted');
ALTER TABLE host_verification_cases ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- verification audits (metadata only, no PII)
CREATE TABLE IF NOT EXISTS verification_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid REFERENCES host_verification_cases(id) ON DELETE SET NULL,
  user_id uuid NOT NULL,
  actor_id uuid,
  action text NOT NULL,                -- consented | submitted | face_scored | approved | rejected | purged | purge_failed | expired
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_audits_case_idx ON verification_audits (case_id, at);
ALTER TABLE verification_audits ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- private bucket for raw ID + liveness frames
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('host-verification', 'host-verification', false, 6291456, ARRAY['image/jpeg', 'image/png'])
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 6291456,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png'];

-- The one thing kept after approval: a clean profile selfie, in its own private bucket (never purged).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('host-selfies', 'host-selfies', false, 3145728, ARRAY['image/jpeg'])
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 3145728,
    allowed_mime_types = ARRAY['image/jpeg'];
