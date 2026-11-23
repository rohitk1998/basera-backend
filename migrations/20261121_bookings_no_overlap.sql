-- Double-booking guard enforced by the database itself.
-- create()/approve() also take a per-listing advisory lock, but this EXCLUDE
-- constraint is the backstop: two bookings that hold dates on one listing can
-- never overlap, whatever the application does. The app maps SQLSTATE 23P01 to 409.
--
-- 'requested' bookings do NOT block (they are not in the status list); approve()
-- fails with 409 if the approval would overlap a blocking booking.
-- The range ends at COALESCE(actual_move_out, move_out), matching the app's
-- availability query, so nights freed by an early departure can be re-booked.
--
-- Idempotent. NOT applied automatically. If it errors with "conflicting key
-- value violates exclusion constraint", existing data already has overlapping
-- blocking bookings: resolve those rows first, then re-run.

create extension if not exists btree_gist;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_no_overlap'
  ) then
    alter table bookings
      add constraint bookings_no_overlap
      exclude using gist (
        listing_id with =,
        daterange(move_in, coalesce(actual_move_out, move_out), '[)') with &&
      )
      where (status in ('confirmed','approved','checked_in','disputed','completed','checked_out'));
  end if;
end $$;
