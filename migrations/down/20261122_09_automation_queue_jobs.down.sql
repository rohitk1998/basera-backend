-- DOWN for 20261122_automation_queue_jobs.sql
-- DATA LOSS: drops job history, automation tuning, reminder idempotency markers (reminders could re-send once)
-- and manually entered acquisition costs.
drop table if exists acquisition_costs;
drop table if exists automation_runs;
drop table if exists reminder_log;
drop table if exists automation_settings;
drop table if exists jobs_log;
