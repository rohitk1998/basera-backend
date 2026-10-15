-- Automated transitions (the 24h payout release) have no user actor. The
-- scheduler used to pass the string 'system' into this uuid FK column, so the
-- audit insert threw after the booking was already completed and the guest's
-- "how was your stay" notification never went out. NULL now means "system".
-- Idempotent — safe to re-run.
alter table booking_events alter column actor drop not null;
