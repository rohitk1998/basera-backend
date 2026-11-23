-- DOWN for 20261121_bookings_reference_idempotency.sql
-- DATA LOSS: drops bookings.reference (RB-XXXXXX codes already shown to users), idempotency_key and pay_by_at.
-- Code in the app that reads these columns will fail after this runs.
drop index if exists bookings_confirmed_pay_by_idx;
drop index if exists bookings_guest_idempotency_key_uq;
alter table if exists bookings drop constraint if exists bookings_reference_key;
alter table if exists bookings
  drop column if exists pay_by_at,
  drop column if exists idempotency_key,
  drop column if exists reference;
