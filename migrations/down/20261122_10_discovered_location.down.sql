-- DOWN for 20261122_10_discovered_location.sql
-- DATA LOSS: drops the derived disc_district/disc_tehsil/disc_lat/disc_lng values (re-derivable with the backfill script
-- from draft_data.discovery lat/lng + discovery_destination). Discovered stays then vanish from /stays.
DROP INDEX IF EXISTS listings_discovered_grid_idx;
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_disc_latlng_range;
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_disc_location_scope;
ALTER TABLE listings DROP COLUMN IF EXISTS disc_lng;
ALTER TABLE listings DROP COLUMN IF EXISTS disc_lat;
ALTER TABLE listings DROP COLUMN IF EXISTS disc_tehsil;
ALTER TABLE listings DROP COLUMN IF EXISTS disc_district;
