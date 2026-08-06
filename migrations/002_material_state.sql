ALTER TABLE jobs ADD COLUMN IF NOT EXISTS material_fingerprint text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS jobs_stale_open_idx ON jobs(last_seen_at) WHERE status = 'OPEN';
