-- Check-in code lockout state shared across API instances (was an in-memory Map).
-- Idempotent. NOT applied automatically.

create table if not exists check_in_lockouts (
  booking_id   uuid primary key references bookings(id) on delete cascade,
  failed_count integer not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

-- Backend connects with a privileged role; block anon/authenticated API access.
alter table check_in_lockouts enable row level security;
