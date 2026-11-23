-- DOWN for 20261121_bookings_checkin_lockouts.sql
-- DATA LOSS: drops check_in_lockouts (transient lockout counters; low impact, but active lockouts reset).
drop table if exists check_in_lockouts;
