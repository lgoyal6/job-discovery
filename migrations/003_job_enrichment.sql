-- Sponsorship verdicts recovered by fetching a posting's own page.
--
-- Kept out of jobs.sponsorship_status deliberately: upsertJob rewrites that
-- column every run from source data, and community rows carry no description,
-- so an enriched verdict stored there would be erased on the next tick and the
-- same page refetched forever.
CREATE TABLE IF NOT EXISTS job_enrichment (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('SUPPORTED', 'UNSUPPORTED', 'UNKNOWN')),
  evidence text NOT NULL DEFAULT '',
  source_url text NOT NULL DEFAULT '',
  -- Records the attempt, not just the success. A page that yielded nothing
  -- usable must not be retried every two hours forever.
  fetched_at timestamptz NOT NULL DEFAULT now(),
  http_ok boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS job_enrichment_status_idx ON job_enrichment(status);
