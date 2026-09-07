CREATE TABLE forgotten_jobs (
  canonical_key text PRIMARY KEY,
  normalized_company text NOT NULL,
  normalized_title text NOT NULL,
  cycle text NOT NULL,
  urls text[] NOT NULL DEFAULT '{}',
  source_ids text[] NOT NULL DEFAULT '{}',
  deleted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX forgotten_jobs_urls_idx ON forgotten_jobs USING gin(urls);
CREATE INDEX forgotten_jobs_source_ids_idx ON forgotten_jobs USING gin(source_ids);
