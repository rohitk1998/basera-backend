-- Notification pipeline: in_app feed rows vs real delivery rows, dedupe keys, contact consent.
-- Idempotent: safe to re-run.

ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS dedupe_key text;

-- Channel CHECK: allow 'in_app'. Existing constraint (name unknown) is dropped by lookup.
-- Legacy 'push' rows were all feed rows (real push results were never persisted), so convert them once,
-- only on the run that actually widens the constraint (later 'push' rows are real delivery rows).
DO $$
DECLARE
  c record;
  widened boolean := false;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'notification_log'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%channel%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%in_app%'
  LOOP
    EXECUTE format('ALTER TABLE notification_log DROP CONSTRAINT %I', c.conname);
    widened := true;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'notification_log'::regclass AND conname = 'notification_log_channel_check'
  ) THEN
    ALTER TABLE notification_log
      ADD CONSTRAINT notification_log_channel_check CHECK (channel IN ('in_app', 'email', 'push'));
  END IF;

  IF widened THEN
    UPDATE notification_log SET channel = 'in_app' WHERE channel = 'push';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS notification_log_dedupe_uidx
  ON notification_log (user_id, event, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS notification_log_feed_idx
  ON notification_log (user_id, sent_at DESC, id DESC)
  WHERE channel = 'in_app';

-- Contact consent per subject/channel (used by WhatsApp / outreach phases).
CREATE TABLE IF NOT EXISTS contact_preferences (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type   text NOT NULL,
  subject_id     text NOT NULL,
  channel        text NOT NULL CHECK (channel IN ('email', 'push', 'whatsapp', 'sms')),
  consent_status text NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('granted', 'revoked', 'unknown')),
  consented_at   timestamptz,
  source         text,
  revoked_at     timestamptz,
  UNIQUE (subject_type, subject_id, channel)
);

-- RLS on, no policies: only the backend (owner/service role) reaches it.
ALTER TABLE contact_preferences ENABLE ROW LEVEL SECURITY;
