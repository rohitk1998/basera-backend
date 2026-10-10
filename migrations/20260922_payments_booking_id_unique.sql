-- A booking has at most one payment row (release/refund/splitRelease all
-- update the existing row rather than inserting a new one), but nothing
-- enforced that — bookings.service.ts pay() only guarded against a second
-- payment with an application-level check-then-insert (getForBooking, then
-- createHeldPayment), which two concurrent calls for the same booking can
-- both pass before either commits, producing a double payment row. A
-- unique constraint makes the second insert fail at the database instead,
-- closing the race regardless of what the application layer checked.
--
-- Replaces idx_payments_booking_id (migrations/20260921_perf_indexes.sql)
-- with a unique index of the same name and columns — a plain and a unique
-- index on the same column would be redundant.
drop index if exists idx_payments_booking_id;

create unique index if not exists idx_payments_booking_id
  on payments (booking_id);
