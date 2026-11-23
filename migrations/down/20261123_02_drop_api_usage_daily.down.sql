CREATE TABLE IF NOT EXISTS api_usage_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL, day date NOT NULL,
  requests integer NOT NULL DEFAULT 0, errors integer NOT NULL DEFAULT 0, last_error text,
  UNIQUE (source, day)
);
-- Data is not restored (it was counters only).
