alter table if exists bookings
  add column if not exists gross_booking_amount integer not null default 0,
  add column if not exists platform_commission integer not null default 0,
  add column if not exists host_payout_amount integer not null default 0;
