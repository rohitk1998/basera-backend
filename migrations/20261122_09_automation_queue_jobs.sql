-- Phase 8/9: jobs_log (JobRouter audit trail), automation settings/runs, reminder idempotency, acquisition costs.
-- Idempotent. NOT applied automatically (lead applies). Pure additive: no existing table is touched.
BEGIN;

CREATE TABLE IF NOT EXISTS jobs_log (
  id          bigserial PRIMARY KEY,
  job_id      text NOT NULL,
  queue       text NOT NULL,
  name        text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  state       text NOT NULL DEFAULT 'active' CHECK (state IN ('active','completed','failed','dead')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error       text,
  UNIQUE (queue, job_id)
);
CREATE INDEX IF NOT EXISTS jobs_log_state_idx ON jobs_log (state, started_at DESC);
CREATE INDEX IF NOT EXISTS jobs_log_queue_idx ON jobs_log (queue, started_at DESC);

CREATE TABLE IF NOT EXISTS automation_settings (
  kind        text PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT true,
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per (kind, subject, bucket): the guarantee of at most one reminder per bucket.
CREATE TABLE IF NOT EXISTS reminder_log (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  subject_type text NOT NULL,
  subject_id   text NOT NULL,
  bucket       text NOT NULL,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, subject_id, bucket)
);
CREATE INDEX IF NOT EXISTS reminder_log_sent_idx ON reminder_log (kind, sent_at DESC);

CREATE TABLE IF NOT EXISTS automation_runs (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  dry_run     boolean NOT NULL DEFAULT false,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  candidates  integer NOT NULL DEFAULT 0,
  sent        integer NOT NULL DEFAULT 0,
  skipped     integer NOT NULL DEFAULT 0,
  error       text,
  triggered_by uuid
);
CREATE INDEX IF NOT EXISTS automation_runs_kind_idx ON automation_runs (kind, started_at DESC);

-- Manual acquisition spend. period = 'YYYY-MM'.
CREATE TABLE IF NOT EXISTS acquisition_costs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period        text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount_rupees integer NOT NULL CHECK (amount_rupees >= 0),
  note          text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS acquisition_costs_period_idx ON acquisition_costs (period);

COMMIT;
