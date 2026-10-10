-- Attractions: the treks, temples, waterfalls, forts, museums, viewpoints,
-- lakes and adventure spots shown next to stays on the /stays search page
-- ("Explore <district>"). See src/attractions/.
--
-- Rows come from two places:
--   source = 'wikidata'     imported by AttractionsImportService from places
--                           that have an English Wikipedia article, always as
--                           a draft; (source, source_id) makes re-imports a no-op
--   source = 'manual'       created by an admin (treks, mostly)
-- Guests only ever see status = 'published'.
--
-- Images are copied into the public basera_assets bucket at import time, so
-- a guest request never reaches Wikimedia. image_credit is shown under every
-- photo and must not be dropped.
create table if not exists attractions (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  category      text not null check (category in
                  ('trek', 'temple', 'waterfall', 'fort', 'museum', 'adventure', 'viewpoint', 'lake')),
  district      text not null,
  tehsil        text,
  lat           double precision not null,
  lng           double precision not null,
  summary       text,
  description   text,
  image_url     text,
  image_credit  text,
  difficulty    text check (difficulty is null or difficulty in ('easy', 'moderate', 'hard')),
  duration      text,
  distance_km   numeric(6, 1),
  best_season   text,
  youtube_ids   text[] not null default '{}',
  popularity    smallint not null default 0,
  source        text not null check (source in ('wikidata', 'manual')),
  source_id     text,
  wikipedia_url text,
  status        text not null default 'draft' check (status in ('draft', 'published', 'hidden')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (source, source_id)
);

-- The guest read: one district's published rows, by category, most popular first.
create index if not exists idx_attractions_district_status
  on attractions (district, status, category, popularity desc);
