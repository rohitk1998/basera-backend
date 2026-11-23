-- DOWN for 20261121_listings_discovered.sql
-- DATA LOSS: drops all discovered-listing metadata and claim history columns.
-- FIRST delete or archive discovered rows (is_discovered = true) manually: they have no host_id, so the
-- host_id NOT NULL restoration below is deliberately NOT done here (it would fail while such rows exist).
-- Original listings_status_check values are not known to this file; the widened constraint is dropped, not restored.
-- Re-add the original status CHECK by hand if you need it.
drop index if exists listings_is_discovered_idx;
drop index if exists listings_discovered_place_uniq;
alter table if exists listings drop constraint if exists listings_discovered_not_public;
alter table if exists listings drop constraint if exists listings_host_required_unless_discovered;
alter table if exists listings drop constraint if exists listings_status_check;
alter table if exists listings
  drop column if exists claimed_by,
  drop column if exists claimed_at,
  drop column if exists discovered_at,
  drop column if exists external_place_id,
  drop column if exists discovery_source,
  drop column if exists is_discovered;
