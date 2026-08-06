CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_key text NOT NULL UNIQUE,
  company text NOT NULL,
  normalized_company text NOT NULL,
  title text NOT NULL,
  normalized_title text NOT NULL,
  location text NOT NULL DEFAULT 'Unspecified',
  normalized_location text NOT NULL,
  cycle text NOT NULL,
  category text NOT NULL,
  sponsorship_status text NOT NULL CHECK (sponsorship_status IN ('SUPPORTED','UNKNOWN','UNSUPPORTED')),
  sponsorship_evidence text,
  description text,
  employment_type text,
  required_skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  score integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  sent_at timestamptz,
  closed_at timestamptz,
  reopened_at timestamptz,
  material_version integer NOT NULL DEFAULT 1,
  material_fingerprint text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_name text NOT NULL,
  source_job_id text,
  source_url text NOT NULL,
  direct_apply_url text,
  posted_at timestamptz,
  scraped_at timestamptz NOT NULL,
  verification_status text NOT NULL DEFAULT 'UNVERIFIED',
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_name, source_job_id),
  UNIQUE (job_id, source_url)
);

CREATE INDEX IF NOT EXISTS job_sources_job_idx ON job_sources(job_id);
CREATE INDEX IF NOT EXISTS jobs_sent_idx ON jobs(sent_at) WHERE sent_at IS NULL;

CREATE TABLE IF NOT EXISTS source_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_run_id uuid NOT NULL,
  source_name text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCESS','DEGRADED','FAILED','SKIPPED')),
  fetched_count integer NOT NULL DEFAULT 0,
  accepted_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  duration_ms integer,
  watermark jsonb,
  error_code text,
  error_message text,
  cost_units numeric(12,4) NOT NULL DEFAULT 0,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS email_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_key text NOT NULL UNIQUE,
  pipeline_run_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'CLAIMED' CHECK (status IN ('CLAIMED','SENT','ABANDONED')),
  job_ids uuid[] NOT NULL,
  subject text NOT NULL,
  digest_hash text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  provider_message_id text,
  UNIQUE (digest_hash)
);

CREATE TABLE IF NOT EXISTS watchlist_states (
  company text NOT NULL,
  cycle text NOT NULL,
  state text NOT NULL CHECK (state IN ('OPEN','ANNOUNCED','EXPECTED','NO_SIGNAL','CLOSED')),
  next_open_at date,
  source_url text,
  last_checked_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, cycle)
);

CREATE TABLE IF NOT EXISTS company_aliases (
  alias_normalized text PRIMARY KEY,
  canonical_company text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sponsorship_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_normalized text NOT NULL,
  source_job_id text,
  canonical_url text,
  status text NOT NULL CHECK (status IN ('SUPPORTED','UNKNOWN','UNSUPPORTED')),
  evidence text NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_job_id IS NOT NULL OR canonical_url IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_override_source_idx
  ON sponsorship_overrides(company_normalized, source_job_id) WHERE source_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pipeline_watermarks (
  source_name text PRIMARY KEY,
  watermark jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS applied_exclusions (
  notion_page_id text PRIMARY KEY,
  company_normalized text NOT NULL,
  title_normalized text NOT NULL,
  canonical_url text,
  source_job_id text,
  synced_at timestamptz NOT NULL DEFAULT now()
);
