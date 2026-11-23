-- Phase 3: property claiming & verification. Idempotent. NOT applied automatically (lead applies).
-- Depends on 20261121_listings_discovered.sql (listings.is_discovered / claimed_by / claimed_at).
BEGIN;

CREATE TABLE IF NOT EXISTS property_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  claimant_user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner','manager')),
  business_name text,
  contact_phone text,
  contact_email text,
  authority_statement text,
  terms_version text,
  terms_accepted_at timestamptz,
  invitation_id uuid,
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN
    ('DRAFT','SUBMITTED','UNDER_REVIEW','MORE_INFORMATION_REQUIRED','APPROVED','REJECTED','WITHDRAWN')),
  reviewer_id uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  info_request_note text,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Two APPROVED claims can never exist on one property.
CREATE UNIQUE INDEX IF NOT EXISTS property_claims_one_approved_idx
  ON property_claims (listing_id) WHERE state = 'APPROVED';
-- One open claim per (listing, claimant).
CREATE UNIQUE INDEX IF NOT EXISTS property_claims_one_open_per_claimant_idx
  ON property_claims (listing_id, claimant_user_id)
  WHERE state IN ('DRAFT','SUBMITTED','UNDER_REVIEW','MORE_INFORMATION_REQUIRED');
CREATE INDEX IF NOT EXISTS property_claims_state_idx ON property_claims (state, created_at);
CREATE INDEX IF NOT EXISTS property_claims_claimant_idx ON property_claims (claimant_user_id);

CREATE TABLE IF NOT EXISTS claim_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES property_claims(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN
    ('business_registration','ownership_document','management_agreement','utility_bill','property_photo','other')),
  storage_path text NOT NULL,
  mime text NOT NULL,
  size integer NOT NULL CHECK (size > 0),
  sha256 text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '180 days'),
  purged_at timestamptz
);
CREATE INDEX IF NOT EXISTS claim_evidence_claim_idx ON claim_evidence (claim_id);
CREATE INDEX IF NOT EXISTS claim_evidence_purge_idx ON claim_evidence (retention_until) WHERE purged_at IS NULL;

CREATE TABLE IF NOT EXISTS claim_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES property_claims(id) ON DELETE CASCADE,
  actor_id uuid,
  actor_role text NOT NULL,
  action text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_events_claim_idx ON claim_events (claim_id, at);

CREATE OR REPLACE FUNCTION claim_events_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'claim_events is append-only';
  END IF;
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM property_claims WHERE id = OLD.claim_id) THEN
    RAISE EXCEPTION 'claim_events is append-only';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS claim_events_append_only_trg ON claim_events;
CREATE TRIGGER claim_events_append_only_trg
  BEFORE UPDATE OR DELETE ON claim_events
  FOR EACH ROW EXECUTE FUNCTION claim_events_append_only();

CREATE TABLE IF NOT EXISTS claim_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  claim_ids uuid[] NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  resolution text
);
CREATE UNIQUE INDEX IF NOT EXISTS claim_disputes_one_open_idx ON claim_disputes (listing_id) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS property_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','manager')),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (listing_id, user_id)
);
CREATE INDEX IF NOT EXISTS property_members_user_idx ON property_members (user_id) WHERE revoked_at IS NULL;

-- Server-side only: no policies, so the public Supabase API cannot read or write these tables.
ALTER TABLE property_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_members ENABLE ROW LEVEL SECURITY;

-- Private evidence bucket (never public; read only through 120s signed URLs minted by admins).
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public) VALUES ('claim-evidence', 'claim-evidence', false)
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

COMMIT;
