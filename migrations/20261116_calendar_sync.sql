-- Host calendar sync (iCal). See src/calendar-sync/.
--   listing_calendar_sync   one row per listing: secret export token + optional import URL.
--   listing_calendar_blocks date ranges imported from the host's external calendar
--                           (ends_on is exclusive, like iCal all-day DTEND).
--
-- Additive only: creates new tables, touches no existing table or row.
-- Idempotent - safe to re-run.
--
-- RLS: enabled with no policies, like the other backend-only tables. The Nest
-- backend connects as the database owner and enforces access itself.
begin;

create table if not exists listing_calendar_sync (
  listing_id      uuid primary key references listings(id) on delete cascade,
  export_token    text not null,
  import_url      text,
  last_synced_at  timestamptz,
  last_sync_error text,
  created_at      timestamptz not null default now()
);

create table if not exists listing_calendar_blocks (
  id         uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id) on delete cascade,
  uid        text not null,
  starts_on  date not null,
  ends_on    date not null check (ends_on > starts_on),
  created_at timestamptz not null default now()
);
create index if not exists idx_listing_calendar_blocks_range
  on listing_calendar_blocks (listing_id, starts_on, ends_on);

alter table listing_calendar_sync enable row level security;
alter table listing_calendar_blocks enable row level security;

commit;
