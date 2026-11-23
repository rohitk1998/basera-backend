-- Quality vetting: admin-typed external rating per listing + append-only periodic audit notes.
-- Idempotent. NOT applied automatically: run it yourself, then restart the backend.

CREATE TABLE IF NOT EXISTS listing_vetting (
  listing_id uuid PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  external_rating numeric(2,1) CHECK (external_rating IS NULL OR (external_rating >= 0 AND external_rating <= 5)),
  external_rating_source text CHECK (external_rating_source IS NULL OR external_rating_source IN ('google_maps', 'airbnb', 'booking', 'other')),
  external_review_count integer CHECK (external_review_count IS NULL OR external_review_count >= 0),
  external_url text CHECK (external_url IS NULL OR external_url ~* '^https://'),
  checked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  checked_at timestamptz
);

CREATE TABLE IF NOT EXISTS listing_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  auditor_id uuid NOT NULL REFERENCES users(id),
  outcome text NOT NULL CHECK (outcome IN ('pass', 'warn', 'fail')),
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listing_audits_listing_created_idx
  ON listing_audits (listing_id, created_at DESC);

-- Append-only: UPDATE is always refused; DELETE only when the parent listing is already gone (cascade).
CREATE OR REPLACE FUNCTION listing_audits_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'listing_audits is append-only';
  END IF;
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM listings WHERE id = OLD.listing_id) THEN
    RAISE EXCEPTION 'listing_audits is append-only';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS listing_audits_append_only_trg ON listing_audits;
CREATE TRIGGER listing_audits_append_only_trg
  BEFORE UPDATE OR DELETE ON listing_audits
  FOR EACH ROW EXECUTE FUNCTION listing_audits_append_only();

-- Server-side only: no policies, so the public Supabase API cannot read or write these tables.
ALTER TABLE listing_vetting ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_audits ENABLE ROW LEVEL SECURITY;
