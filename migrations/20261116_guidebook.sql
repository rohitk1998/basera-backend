-- Host-written guidebook: wifi, house rules, nearest clinic, emergency numbers.
-- One row per listing; sections is a JSON array of {title, body} (max 12,
-- title 80 chars, body 2000 chars, enforced by the API). Only guests with a
-- confirmed, checked_in or completed booking for the listing can read it.
-- See src/guidebook/.
create table if not exists guidebooks (
  listing_id uuid primary key references listings (id) on delete cascade,
  sections   jsonb not null default '[]'::jsonb check (jsonb_typeof(sections) = 'array'),
  updated_at timestamptz not null default now()
);

-- Server-side only: no policies, so the public Supabase API cannot read or write this table.
ALTER TABLE guidebooks ENABLE ROW LEVEL SECURITY;
