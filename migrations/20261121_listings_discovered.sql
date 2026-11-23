-- Discovered (unclaimed) candidate properties live in the SAME listings table, flagged is_discovered.
-- They are never public, searchable, bookable, chat-able or phone-revealable until claimed.
-- Claim = set host_id, is_discovered=false, claimed_at/claimed_by, status -> 'draft', then normal onboarding.
-- Stores only the provider Place ID + permitted metadata; display content is fetched live, not copied.
-- Idempotent. NOT applied automatically: run it yourself, then restart the backend.

BEGIN;

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS is_discovered     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS discovery_source  text,
  ADD COLUMN IF NOT EXISTS external_place_id text,
  ADD COLUMN IF NOT EXISTS discovered_at     timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_by        uuid REFERENCES users(id) ON DELETE SET NULL;

-- host_id: DROP NOT NULL is a harmless no-op if it is already nullable.
ALTER TABLE listings ALTER COLUMN host_id DROP NOT NULL;

ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_host_required_unless_discovered;
ALTER TABLE listings ADD CONSTRAINT listings_host_required_unless_discovered
  CHECK (host_id IS NOT NULL OR is_discovered = true);

-- Every status in use, plus 'discovered' and 'archived'. Added NOT VALID-free: fails loudly if a stray status exists.
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_status_check;
ALTER TABLE listings ADD CONSTRAINT listings_status_check
  CHECK (status IN ('draft','in_review','changes_needed','rejected','live','paused','discovered','archived'));

-- A discovered row can never be live or queued for review before it is claimed.
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_discovered_not_public;
ALTER TABLE listings ADD CONSTRAINT listings_discovered_not_public
  CHECK (NOT is_discovered OR status NOT IN ('live','in_review'));

-- One candidate per provider place.
CREATE UNIQUE INDEX IF NOT EXISTS listings_discovered_place_uniq
  ON listings (discovery_source, external_place_id)
  WHERE is_discovered;

CREATE INDEX IF NOT EXISTS listings_is_discovered_idx ON listings (is_discovered);

COMMIT;
