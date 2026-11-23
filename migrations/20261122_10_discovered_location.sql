-- Discovered (Google Places) listings: our OWN derived location only. Never Google name/address/photos/rating.
-- Values are canonical HP_LOCATIONS spellings, filled at discovery insert and by scripts/backfill-discovered-location.mjs.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS disc_district text;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS disc_tehsil text;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS disc_lat double precision;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS disc_lng double precision;

-- disc_* may only be set on discovered rows. claimed_at is allowed because claim approval flips is_discovered to false.
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_disc_location_scope;
ALTER TABLE listings ADD CONSTRAINT listings_disc_location_scope CHECK (
  is_discovered OR claimed_at IS NOT NULL
  OR (disc_district IS NULL AND disc_tehsil IS NULL AND disc_lat IS NULL AND disc_lng IS NULL)
);

ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_disc_latlng_range;
ALTER TABLE listings ADD CONSTRAINT listings_disc_latlng_range CHECK (
  (disc_lat IS NULL AND disc_lng IS NULL)
  OR (disc_lat BETWEEN -90 AND 90 AND disc_lng BETWEEN -180 AND 180)
);

CREATE INDEX IF NOT EXISTS listings_discovered_grid_idx
  ON listings (lower(disc_district), lower(disc_tehsil), created_at DESC, id DESC)
  WHERE is_discovered AND status = 'discovered' AND host_id IS NULL
    AND discovery_source = 'google_places' AND disc_district IS NOT NULL;
