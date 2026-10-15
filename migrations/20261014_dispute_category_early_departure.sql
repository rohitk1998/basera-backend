-- Adds the 'early_departure' dispute category (guest wants to leave before
-- move-out and raises a dispute instead of an instant checkout).
-- Idempotent — safe to re-run.
alter table dispute_cases drop constraint if exists dispute_cases_category_check;
alter table dispute_cases
  add constraint dispute_cases_category_check
  check (category in ('not_as_described', 'cleanliness', 'damage_safety', 'host_unresponsive_or_cancelled', 'early_departure', 'other'));
