-- Performance indexes for the hottest read paths — listings search
-- (GET /api/listings, GET /api/listings/towns) and the bookings list/pay/
-- dispute flow. None of these existed before, so every one of these queries
-- was a full table scan (or, for the jsonb paths, a scan re-parsing JSON on
-- every row).

-- payments.getForBooking / getForBookings — the sole predicate on the
-- hottest payment lookup (booking detail, list, pay/checkin/dispute).
create index if not exists idx_payments_booking_id
  on payments (booking_id);

-- bookings: FK/status columns used in WHERE and in the listings-search
-- NOT EXISTS overlap subquery (listings.service.ts getMany's `moveIn`
-- branch), none of which had an index.
create index if not exists idx_bookings_guest_id
  on bookings (guest_id);

create index if not exists idx_bookings_host_id
  on bookings (host_id);

-- Composite, not a bare listing_id index: the overlap subquery always
-- filters listing_id + status together, and adding move_in/move_out keeps
-- the whole WHERE clause (listing_id, status, then the date-range overlap
-- test) index-only wherever possible instead of a listing_id-only lookup
-- followed by a heap re-check of status/dates for every matching row.
create index if not exists idx_bookings_listing_status_dates
  on bookings (listing_id, status, move_in, move_out);

-- listings.status — every search/town-summary query starts with
-- `WHERE status = 'live'`, and it's also the sole predicate behind the
-- admin dashboard's per-status counts (getStats/getProperties).
create index if not exists idx_listings_status
  on listings (status);

-- listings.draft_data — the public search/filter path (listings.service.ts
-- getMany/getTownSummaries) reads several fixed jsonb paths under
-- property_details on every request; each gets its own expression index
-- rather than one blanket GIN(draft_data), since the predicates are mostly
-- range/equality/ILIKE on specific scalar paths, not whole-document
-- containment (the one exception, `categories`, gets its own GIN below).

-- Exact/prefix predicates: town (search filter + town-summary GROUP BY),
-- category containment, and the trust-score sort.
create index if not exists idx_listings_town
  on listings ((draft_data->'property_details'->>'town'));

create index if not exists idx_listings_categories_gin
  on listings using gin ((draft_data->'property_details'->'categories'));

create index if not exists idx_listings_trust_score
  on listings (((draft_data->>'trustScore')::int));

-- availableFrom/minDays: filtered together whenever a search carries a
-- moveIn date (the eligibility check ahead of the booking-overlap check).
-- Indexed as text, not ::date: Postgres's text->date cast is STABLE, not
-- IMMUTABLE (it can depend on the session's DateStyle), which index
-- expressions require. availableFrom is always stored as an ISO
-- YYYY-MM-DD string (see listing-schema.ts), so a plain text index still
-- accelerates the equality/range comparison the query actually runs.
create index if not exists idx_listings_available_from
  on listings ((draft_data->'property_details'->>'availableFrom'));

-- Free-text search (town/title/description ILIKE '%q%') and the town
-- filter's own ILIKE can't use a plain B-tree for a leading-wildcard
-- pattern — trigram indexes are what make ILIKE '%text%' seekable instead
-- of a sequential scan.
create extension if not exists pg_trgm;

create index if not exists idx_listings_title_trgm
  on listings using gin ((draft_data->'property_details'->>'title') gin_trgm_ops);

create index if not exists idx_listings_description_trgm
  on listings using gin ((draft_data->'property_details'->>'description') gin_trgm_ops);
