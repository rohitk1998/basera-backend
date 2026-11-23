-- Host attestation: "I checked the guest's ID in person" at check-in.
-- Stores only who/when and an optional document TYPE. Never an ID number or image.
-- Idempotent. NOT applied automatically: run it yourself, then restart the backend.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS host_id_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS host_id_checked_doc_type varchar;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_host_id_checked_doc_type_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_host_id_checked_doc_type_check
  CHECK (host_id_checked_doc_type IS NULL
         OR host_id_checked_doc_type IN ('aadhaar', 'passport', 'driving_licence', 'voter_id', 'other'));
