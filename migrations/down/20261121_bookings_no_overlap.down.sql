-- DOWN for 20261121_bookings_no_overlap.sql
-- Removes the DB-level double-booking guard; only app-level advisory locks remain.
-- The btree_gist extension is intentionally NOT dropped (other objects may depend on it).
alter table if exists bookings drop constraint if exists bookings_no_overlap;
