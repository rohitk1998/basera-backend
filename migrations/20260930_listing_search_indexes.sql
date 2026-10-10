-- Indexes for the unified listings search (GET /api/listings with q /
-- district / tehsil / facets — see src/listings/listings.service.ts and
-- listing-search.util.ts).
--
-- The free-text search matches a word PREFIX in each of title, town, tehsil,
-- district, city, locality and streetAddress:
--   field ILIKE 'tok%' OR field ILIKE '% tok%'
-- A B-tree cannot serve the second form, and pg_trgm GIN indexes serve both
-- (and ILIKE in general), so every searched property_details field gets one.
-- `title` already has idx_listings_title_trgm (20260921_perf_indexes.sql);
-- `description` is no longer searched.
create extension if not exists pg_trgm;

create index if not exists idx_listings_town_trgm
  on listings using gin ((draft_data->'property_details'->>'town') gin_trgm_ops);

create index if not exists idx_listings_tehsil_trgm
  on listings using gin ((draft_data->'property_details'->>'tehsil') gin_trgm_ops);

create index if not exists idx_listings_district_trgm
  on listings using gin ((draft_data->'property_details'->>'district') gin_trgm_ops);

create index if not exists idx_listings_city_trgm
  on listings using gin ((draft_data->'property_details'->>'city') gin_trgm_ops);

create index if not exists idx_listings_locality_trgm
  on listings using gin ((draft_data->'property_details'->>'locality') gin_trgm_ops);

create index if not exists idx_listings_street_address_trgm
  on listings using gin ((draft_data->'property_details'->>'streetAddress') gin_trgm_ops);

-- Exact, case-insensitive district / tehsil filters (`?district=` /
-- `?tehsil=`, and the alias match behind "Kasol" -> Bhuntar/Kullu), plus the
-- facet counts that group by them. The queries compare lower(<field>) and
-- always restrict to live listings with the literal `status = 'live'`, so
-- these are partial indexes over live rows only. They must match the query's
-- expression exactly to be used.
create index if not exists idx_listings_live_district_lower
  on listings ((lower(draft_data->'property_details'->>'district')))
  where status = 'live';

create index if not exists idx_listings_live_tehsil_lower
  on listings ((lower(draft_data->'property_details'->>'tehsil')))
  where status = 'live';
