-- Phase 5 guest inquiry engine. Idempotent. NOT applied automatically.
-- An inquiry is a NON-BINDING request. It never creates a booking or payment.
-- candidate_listing_id may point at a discovered (unclaimed) listing; it is resolved server-side only.
BEGIN;

CREATE TABLE IF NOT EXISTS inquiries (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref             text NOT NULL UNIQUE,
  access_token_hash      text NOT NULL,
  guest_user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  guest_name             text NOT NULL,
  guest_phone            text NOT NULL CHECK (guest_phone ~ '^\+[1-9][0-9]{7,14}$'),
  guest_email            text,
  target_listing_id      uuid REFERENCES listings(id) ON DELETE SET NULL,
  candidate_listing_id   uuid REFERENCES listings(id) ON DELETE SET NULL,
  destination            text,
  check_in               date,
  check_out              date,
  guests                 integer CHECK (guests IS NULL OR guests BETWEEN 1 AND 30),
  budget_min             integer CHECK (budget_min IS NULL OR budget_min >= 0),
  budget_max             integer CHECK (budget_max IS NULL OR budget_max >= 0),
  requirements           text,
  consent_contact        boolean NOT NULL,
  consent_at             timestamptz NOT NULL,
  consent_text_version   text NOT NULL,
  state                  text NOT NULL DEFAULT 'NEW'
    CHECK (state IN ('NEW','ASSIGNED','HOST_CONTACTING','HOST_RESPONDED','OFFER_PENDING','OFFER_SENT','CONVERTED','DECLINED','EXPIRED','CLOSED')),
  assigned_to            uuid REFERENCES users(id) ON DELETE SET NULL,
  response_due_at        timestamptz NOT NULL,
  first_response_at      timestamptz,
  offer_pending          boolean NOT NULL DEFAULT false,
  offer_sent_at          timestamptz,
  converted_booking_id   uuid REFERENCES bookings(id) ON DELETE SET NULL,
  dedupe_key             text NOT NULL UNIQUE,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inquiries_consent_given CHECK (consent_contact = true),
  CONSTRAINT inquiries_has_target CHECK (target_listing_id IS NOT NULL OR destination IS NOT NULL),
  CONSTRAINT inquiries_dates_order CHECK (check_in IS NULL OR check_out IS NULL OR check_out > check_in),
  CONSTRAINT inquiries_budget_order CHECK (budget_min IS NULL OR budget_max IS NULL OR budget_max >= budget_min),
  CONSTRAINT inquiries_converted_needs_target CHECK (state <> 'CONVERTED' OR target_listing_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS inquiries_state_due_idx ON inquiries (state, response_due_at);
CREATE INDEX IF NOT EXISTS inquiries_assigned_idx ON inquiries (assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS inquiries_created_idx ON inquiries (created_at DESC);

CREATE TABLE IF NOT EXISTS inquiry_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id  uuid NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
  direction   text NOT NULL CHECK (direction IN ('in','out','internal')),
  channel     text NOT NULL DEFAULT 'web' CHECK (channel IN ('web','phone','whatsapp','email','sms','internal')),
  body        text NOT NULL,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inquiry_messages_inquiry_idx ON inquiry_messages (inquiry_id, at);

CREATE TABLE IF NOT EXISTS inquiry_alternatives (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id    uuid NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
  listing_id    uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  suggested_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inquiry_id, listing_id)
);

CREATE TABLE IF NOT EXISTS inquiry_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id  uuid NOT NULL REFERENCES inquiries(id) ON DELETE RESTRICT,
  type        text NOT NULL,
  from_state  text,
  to_state    text,
  actor_id    uuid,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inquiry_events_inquiry_idx ON inquiry_events (inquiry_id, at);

-- Append-only.
CREATE OR REPLACE FUNCTION inquiry_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'inquiry_events is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS inquiry_events_no_update ON inquiry_events;
CREATE TRIGGER inquiry_events_no_update BEFORE UPDATE OR DELETE ON inquiry_events
  FOR EACH ROW EXECUTE FUNCTION inquiry_events_append_only();

-- RLS on, no policies: only the backend (owner/service role) reaches them.
ALTER TABLE inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiry_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiry_alternatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiry_events ENABLE ROW LEVEL SECURITY;

COMMIT;
