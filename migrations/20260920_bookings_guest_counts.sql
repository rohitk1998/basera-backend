-- Party size per booking — previously not captured at all; a request only
-- ever recorded dates, never who was actually coming. Mirrors GuestsPicker's
-- four-way breakdown (adults/children/infants/pets) rather than a single
-- total, so a host sees the real makeup of the stay, not just a headcount.
-- adults defaults to 1 (GuestsPicker's own EMPTY_GUESTS baseline) since a
-- booking always has at least the requesting guest; the other three default
-- to 0.
alter table if exists bookings
  add column if not exists adults integer not null default 1,
  add column if not exists children integer not null default 0,
  add column if not exists infants integer not null default 0,
  add column if not exists pets integer not null default 0;
