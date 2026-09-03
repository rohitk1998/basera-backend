-- ============================================================
-- Listing content translation cache
-- Run this against the Supabase Postgres instance (same DB the
-- Next.js app's supabase/migrations/*.sql files targeted).
--
-- Host-entered listing text (title, description, house rules,
-- amenities, ...) is stored once, in whatever language the host
-- wrote it in. This table is a cache-aside store of machine
-- translations of that text into a guest's selected locale,
-- filled on first request per (listing, locale, content_hash) and
-- served directly on every request after. content_hash covers a
-- host edit: it changes when the source text changes, so a stale
-- row is simply never matched again rather than needing explicit
-- invalidation.
--
-- Idempotent — safe to re-run.
-- ============================================================

alter table listings
  add column if not exists source_locale text;

create table if not exists listing_translations (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id) on delete cascade,
  locale text not null,
  content_hash text not null,
  source_locale text not null,
  title text,
  description text,
  the_space text,
  guest_access text,
  amenities jsonb,
  house_rules_check_in text,
  house_rules_check_out text,
  status text not null default 'ready',
  created_at timestamptz not null default now(),
  unique (listing_id, locale, content_hash)
);

create index if not exists idx_listing_translations_lookup
  on listing_translations (listing_id, locale, content_hash);
