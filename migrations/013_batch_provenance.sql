-- What a digest actually said about a role, and a way to take a role back out.
--
-- Two gaps, one table.
--
-- Provenance: email_batches records job_ids and a digest hash, and nothing
-- else. But upsertJob rewrites the jobs row in place on every pass and bumps
-- material_version when title, location or cycle change, so the row a batch
-- points at is the current one, not the one that was emailed. Asked "what did
-- Tuesday's digest say about this role", the schema could only answer "look at
-- what it says now". This records the version and fingerprint as they were when
-- the batch was claimed, which is the moment the output was fixed.
--
-- Deletion: job_ids is uuid[] with no foreign key, so a deleted job leaves its
-- id sitting in every batch that carried it, and migrations 007 and 008 both
-- reconstruct send state by unnesting exactly that column. A real reference
-- with ON DELETE CASCADE means forgetting a role also forgets what was said
-- about it, rather than leaving a dangling id that a later backfill re-reads.
CREATE TABLE IF NOT EXISTS email_batch_jobs (
  batch_key text NOT NULL REFERENCES email_batches(batch_key) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- The input version this output was built from, copied at claim time.
  material_version integer NOT NULL,
  material_fingerprint text NOT NULL DEFAULT '',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_key, job_id)
);

-- Deleting one job touches every batch that carried it, and that is the whole
-- point of the table, so make it the cheap direction.
CREATE INDEX IF NOT EXISTS email_batch_jobs_job_idx ON email_batch_jobs(job_id);
