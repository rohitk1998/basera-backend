-- Phase 1 property discovery engine. Idempotent. NOT applied automatically (the lead applies it).
-- Requires 20261121_listings_discovered.sql. Stores Place IDs + operational metadata only (risk R-27).
BEGIN;

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS discovery_state        text NOT NULL DEFAULT 'DISCOVERED',
  ADD COLUMN IF NOT EXISTS discovery_assigned_to  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS discovery_destination  text,
  ADD COLUMN IF NOT EXISTS discovery_category     text,
  ADD COLUMN IF NOT EXISTS discovery_duplicate_of uuid REFERENCES listings(id) ON DELETE SET NULL;

ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_discovery_state_check;
ALTER TABLE listings ADD CONSTRAINT listings_discovery_state_check
  CHECK (discovery_state IN ('DISCOVERED','REVIEW_PENDING','ELIGIBLE_FOR_OUTREACH','CONTACT_IN_PROGRESS',
                             'HOST_INTERESTED','HOST_DECLINED','CONVERTED_TO_PROPERTY','ARCHIVED'));

CREATE INDEX IF NOT EXISTS listings_discovery_queue_idx
  ON listings (discovery_destination, discovery_state, discovered_at DESC) WHERE is_discovered;
CREATE INDEX IF NOT EXISTS listings_discovery_assigned_idx
  ON listings (discovery_assigned_to) WHERE is_discovered;
-- Re-discovery dedupe against claimed rows too (provenance is kept after a claim).
CREATE INDEX IF NOT EXISTS listings_external_place_idx
  ON listings (discovery_source, external_place_id) WHERE external_place_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS discovery_sources (
  key                  text PRIMARY KEY,
  name                 text NOT NULL,
  allows_storage       boolean NOT NULL DEFAULT false,
  attribution_required boolean NOT NULL DEFAULT false,
  retention_days       integer,
  license_notes        text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

INSERT INTO discovery_sources (key, name, allows_storage, attribution_required, retention_days, license_notes) VALUES
  ('google_places', 'Google Places API (New)', false, true, 30,
   'Store Place ID, lat/lng and our own operational metadata only. Names, photos, reviews, ratings, phone and descriptions must be fetched live and shown with attribution. Place IDs should be refreshed at least every 12 months. Re-check Google Maps Platform terms before launch.'),
  ('google_places_dryrun', 'Google Places (dry-run fake data)', true, false, 1,
   'Deterministic fake Place IDs for tests/dev only. Never real inventory.'),
  ('host_authorized', 'Host-authorised submission', true, false, NULL,
   'The host supplied this data and consented to its use; full storage permitted.'),
  ('licensed', 'Licensed dataset', true, false, NULL,
   'Third-party dataset under a licence that permits storage; record the licence terms per import.')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS discovery_settings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination          text NOT NULL UNIQUE,
  categories           text[] NOT NULL DEFAULT ARRAY['homestay','cottage','guest house','resort'],
  max_new_per_run      integer NOT NULL DEFAULT 50 CHECK (max_new_per_run >= 0),
  daily_request_budget integer NOT NULL DEFAULT 100 CHECK (daily_request_budget >= 0),
  schedule_cron        text,
  paused               boolean NOT NULL DEFAULT false,
  updated_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

INSERT INTO discovery_settings (destination, categories) VALUES
  ('Manali',        ARRAY['homestay','cottage','guest house','resort']),
  ('Naggar',        ARRAY['homestay','cottage','guest house']),
  ('Kasol',         ARRAY['homestay','cottage','guest house','resort']),
  ('Jibhi',         ARRAY['homestay','cottage','guest house']),
  ('Tirthan Valley',ARRAY['homestay','cottage','guest house']),
  ('Bir',           ARRAY['homestay','guest house','resort']),
  ('Dharamshala',   ARRAY['homestay','guest house','resort','cottage'])
ON CONFLICT (destination) DO NOTHING;

CREATE TABLE IF NOT EXISTS discovery_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination     text NOT NULL,
  categories      text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','paused','cancelled','done','failed')),
  requests_used   integer NOT NULL DEFAULT 0,
  new_count       integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  max_new         integer,
  error           text,
  started_at      timestamptz,
  finished_at     timestamptz,
  lock_owner      text,
  idempotency_key text NOT NULL UNIQUE,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS discovery_jobs_status_idx ON discovery_jobs (status, created_at DESC);

CREATE TABLE IF NOT EXISTS api_usage_daily (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source   text NOT NULL,
  day      date NOT NULL,
  requests integer NOT NULL DEFAULT 0,
  errors   integer NOT NULL DEFAULT 0,
  last_error text,
  UNIQUE (source, day)
);

COMMIT;
