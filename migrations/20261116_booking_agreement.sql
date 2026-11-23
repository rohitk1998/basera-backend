-- Digital booking agreement: one acknowledgement per (booking, user).
-- Idempotent. NOT applied automatically: run it yourself, then restart the backend.

CREATE TABLE IF NOT EXISTS booking_agreement_acks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  version text NOT NULL,
  text_hash text NOT NULL,             -- sha256 of the rendered agreement the user acknowledged
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  CONSTRAINT booking_agreement_acks_booking_user_key UNIQUE (booking_id, user_id)
);
CREATE INDEX IF NOT EXISTS booking_agreement_acks_booking_idx ON booking_agreement_acks (booking_id);
ALTER TABLE booking_agreement_acks ENABLE ROW LEVEL SECURITY;
