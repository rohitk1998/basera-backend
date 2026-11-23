-- Phase 4: verified listing management. Idempotent.

-- (b) booking eligibility, separate from publication. Existing live rows keep working.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'listings' AND column_name = 'booking_eligible') THEN
    ALTER TABLE listings ADD COLUMN booking_eligible boolean NOT NULL DEFAULT false;
    UPDATE listings SET booking_eligible = true WHERE status = 'live' AND is_discovered = false;
  END IF;
END $$;

-- (a) typed long-stay pricing (money = integer rupees) + booking buffer
CREATE TABLE IF NOT EXISTS listing_pricing (
  listing_id         uuid PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  daily_rate         integer NOT NULL CHECK (daily_rate BETWEEN 500 AND 100000),
  weekly_price       integer CHECK (weekly_price IS NULL OR (weekly_price >= 0 AND weekly_price <= daily_rate * 7)),
  monthly_price      integer CHECK (monthly_price IS NULL OR (monthly_price >= 0 AND monthly_price <= daily_rate * 30)),
  security_deposit   integer CHECK (security_deposit IS NULL OR security_deposit BETWEEN 0 AND 500000),
  electricity_mode   text CHECK (electricity_mode IS NULL OR electricity_mode IN ('included','per_unit','flat')),
  electricity_charge integer CHECK (electricity_charge IS NULL OR electricity_charge BETWEEN 0 AND 10000),
  cleaning_charge    integer CHECK (cleaning_charge IS NULL OR cleaning_charge BETWEEN 0 AND 20000),
  extra_guest_fee    integer CHECK (extra_guest_fee IS NULL OR extra_guest_fee BETWEEN 0 AND 10000),
  included_guests    integer CHECK (included_guests IS NULL OR included_guests BETWEEN 1 AND 20),
  utilities_included text[] NOT NULL DEFAULT '{}'
    CHECK (utilities_included <@ ARRAY['water','electricity','wifi','gas','housekeeping']::text[]),
  buffer_days        smallint NOT NULL DEFAULT 0 CHECK (buffer_days BETWEEN 0 AND 3),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (electricity_mode IS NULL OR electricity_mode = 'included' OR electricity_charge > 0)
);

-- (c) append-only status history
CREATE TABLE IF NOT EXISTS listing_status_history (
  id          bigserial PRIMARY KEY,
  listing_id  uuid NOT NULL, -- no FK: history must survive (and a cascade would trip the append-only trigger)
  from_status text,
  to_status   text NOT NULL,
  actor_id    uuid,
  reason      text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listing_status_history_listing_idx ON listing_status_history (listing_id, at DESC);

CREATE OR REPLACE FUNCTION listing_status_history_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'listing_status_history is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS listing_status_history_no_change ON listing_status_history;
CREATE TRIGGER listing_status_history_no_change
  BEFORE UPDATE OR DELETE ON listing_status_history
  FOR EACH ROW EXECUTE FUNCTION listing_status_history_append_only();

-- (d) content provenance
CREATE TABLE IF NOT EXISTS listing_field_provenance (
  listing_id      uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  field           text NOT NULL,
  source          text NOT NULL CHECK (source IN ('host','admin','licensed','google_display_only')),
  captured_at     timestamptz NOT NULL DEFAULT now(),
  permitted_until timestamptz,
  note            text,
  PRIMARY KEY (listing_id, field),
  CHECK (source <> 'google_display_only' OR permitted_until IS NOT NULL),
  CHECK (source <> 'google_display_only'
         OR field NOT IN ('title','description','theSpace','guestAccess','photos','amenities','houseRules','address','pricing'))
);
