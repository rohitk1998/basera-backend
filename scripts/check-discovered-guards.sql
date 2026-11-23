-- Read-only self-check for discovered-listing guards. Run: psql "$DATABASE_URL" -f scripts/check-discovered-guards.sql
-- Every row returned under "VIOLATION" is a problem; zero rows = pass. Writes nothing.
\echo '== columns present (expect 6 rows)'
SELECT column_name FROM information_schema.columns
 WHERE table_name='listings' AND column_name IN ('is_discovered','discovery_source','external_place_id','discovered_at','claimed_at','claimed_by');
\echo '== constraints present (expect 3 rows)'
SELECT conname FROM pg_constraint WHERE conrelid='listings'::regclass
  AND conname IN ('listings_host_required_unless_discovered','listings_status_check','listings_discovered_not_public');
\echo '== VIOLATION: discovered row that is live or in_review'
SELECT id, status FROM listings WHERE is_discovered AND status IN ('live','in_review');
\echo '== VIOLATION: null host_id on a non-discovered row'
SELECT id FROM listings WHERE host_id IS NULL AND NOT is_discovered;
\echo '== VIOLATION: discovered row that has a host_id'
SELECT id FROM listings WHERE is_discovered AND host_id IS NOT NULL;
\echo '== VIOLATION: duplicate discovered place ids'
SELECT discovery_source, external_place_id, count(*) FROM listings WHERE is_discovered
 GROUP BY 1,2 HAVING count(*) > 1;
\echo '== VIOLATION: public query shape returns a discovered row'
SELECT id FROM listings l WHERE l.status='live' AND l.is_discovered = false AND l.is_discovered;
\echo '== VIOLATION: bookings or conversations pointing at a discovered listing'
SELECT 'booking' AS kind, b.id FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE l.is_discovered
UNION ALL
SELECT 'conversation', c.id FROM conversations c JOIN listings l ON l.id=c.listing_id WHERE l.is_discovered;
\echo '== VIOLATION: claimed rows missing provenance'
SELECT id FROM listings WHERE claimed_at IS NOT NULL AND (claimed_by IS NULL OR host_id IS NULL OR is_discovered);
\echo '== status values outside the allow-list'
SELECT DISTINCT status FROM listings
 WHERE status NOT IN ('draft','in_review','changes_needed','rejected','live','paused','discovered','archived');
\echo '== disc_* columns present (expect 4 rows)'
SELECT column_name FROM information_schema.columns
 WHERE table_name='listings' AND column_name IN ('disc_district','disc_tehsil','disc_lat','disc_lng');
\echo '== discovered rows without disc_district (expect only outside-HP or not-yet-backfilled rows)'
SELECT id, discovery_destination, draft_data->'discovery'->>'lat' AS lat, draft_data->'discovery'->>'lng' AS lng
  FROM listings WHERE is_discovered AND discovery_source='google_places' AND disc_district IS NULL;
\echo '== VIOLATION: non-discovered, non-claimed row with disc_* set'
SELECT id FROM listings
 WHERE NOT is_discovered AND claimed_at IS NULL
   AND (disc_district IS NOT NULL OR disc_tehsil IS NOT NULL OR disc_lat IS NOT NULL OR disc_lng IS NOT NULL);
