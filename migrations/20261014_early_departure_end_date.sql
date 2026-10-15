-- Early departure: the guest's chosen leaving date, and the stay's real end.
-- dispute_cases.leaving_on   - date the guest says they leave (early_departure disputes).
-- bookings.actual_move_out   - set when a dispute resolves; availability and
--                              overlap checks use COALESCE(actual_move_out, move_out)
--                              so nights after it are freed immediately.
-- Idempotent - safe to re-run. The backend code requires these columns.
alter table if exists dispute_cases add column if not exists leaving_on date;
alter table if exists bookings add column if not exists actual_move_out date;
