CREATE TABLE IF NOT EXISTS discovery_sources (
  key text PRIMARY KEY, name text NOT NULL, allows_storage boolean NOT NULL DEFAULT false,
  attribution_required boolean NOT NULL DEFAULT false, retention_days integer, license_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Rows are not restored: the source of truth is DISCOVERY_SOURCES in code.
