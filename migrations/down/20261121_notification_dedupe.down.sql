-- DOWN for 20261121_notification_dedupe.sql
-- DATA LOSS: drops contact_preferences (all recorded consent/revocations -- legally sensitive, export first)
-- and notification_log.dedupe_key.
-- NOT reverted: the channel CHECK still allows 'in_app', and legacy 'push' rows converted to 'in_app'
-- cannot be told apart from new in_app rows, so they are not converted back.
drop index if exists notification_log_feed_idx;
drop index if exists notification_log_dedupe_uidx;
alter table if exists notification_log drop column if exists dedupe_key;
drop table if exists contact_preferences;
