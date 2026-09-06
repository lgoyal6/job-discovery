-- What a restored job-discovery database has to be able to say about itself.
--
-- Not row counts. A restore that brought every row and dropped every CHECK
-- passes a count and then accepts the next bad write, and the two checks this
-- file cares most about are ones no constraint in the schema enforces at all:
--
--   * email_batches.job_ids is a uuid[], not a foreign key. markBatchSent
--     stamps sent_at through that array, so an id in it that no longer names a
--     job is a send this pipeline can never account for, and nothing in the
--     schema would notice.
--   * sent_at and the SENT batches have to agree in both directions. Two
--     migrations exist because they once did not, and 125 roles were mailed
--     again after their send state was erased.
--
-- Each check prints its name, the rows that break it, and PASS or FAIL.
--   psql -f scripts/restore-invariants.sql
\pset footer off
\pset border 2

WITH checks AS (

  -- Referential integrity, asserted rather than assumed.
  SELECT 'ref job_sources to jobs' AS name, count(*) AS offending FROM job_sources s
  WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = s.job_id)
  UNION ALL
  SELECT 'ref job_enrichment to jobs', count(*) FROM job_enrichment e
  WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = e.job_id)

  -- The one the schema cannot enforce: every id inside the uuid[] must name a
  -- job that still exists.
  UNION ALL
  SELECT 'ref email_batches.job_ids to jobs', count(*) FROM (
    SELECT DISTINCT unnest(job_ids) AS job_id FROM email_batches) b
  WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = b.job_id)

  -- Send state, both directions. A job named by a confirmed send must carry a
  -- sent_at, and a job carrying one must be named by a confirmed send.
  UNION ALL
  SELECT 'sent batch implies job.sent_at', count(*) FROM (
    SELECT DISTINCT unnest(job_ids) AS job_id FROM email_batches WHERE status = 'SENT') b
  JOIN jobs j ON j.id = b.job_id WHERE j.sent_at IS NULL
  UNION ALL
  SELECT 'job.sent_at implies a sent batch', count(*) FROM jobs j
  WHERE j.sent_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM email_batches b WHERE b.status = 'SENT' AND j.id = ANY(b.job_ids))

  -- A batch's status and its timestamps have to agree, or "did this digest go
  -- out" stops having an answer.
  UNION ALL
  SELECT 'batch status matches sent_at', count(*) FROM email_batches
  WHERE (status = 'SENT') <> (sent_at IS NOT NULL)

  -- A closed role carries the instant it closed; an open one carries none.
  UNION ALL
  SELECT 'closed jobs carry closed_at', count(*) FROM jobs
  WHERE (status = 'CLOSED') <> (closed_at IS NOT NULL)

  -- Time runs forwards.
  UNION ALL
  SELECT 'last_seen_at not before first_seen_at', count(*) FROM jobs WHERE last_seen_at < first_seen_at
  UNION ALL
  SELECT 'updated_at not before created_at', count(*) FROM jobs WHERE updated_at < created_at
  UNION ALL
  SELECT 'source_runs finish after they start', count(*) FROM source_runs
  WHERE finished_at IS NOT NULL AND finished_at < started_at

  -- Uniqueness the pipeline depends on for dedupe and for not mailing twice.
  UNION ALL
  SELECT 'uniq jobs.canonical_key', count(*) FROM (
    SELECT canonical_key FROM jobs GROUP BY 1 HAVING count(*) > 1) x
  UNION ALL
  SELECT 'uniq job_sources source_name+source_job_id', count(*) FROM (
    SELECT source_name, source_job_id FROM job_sources WHERE source_job_id IS NOT NULL
    GROUP BY 1, 2 HAVING count(*) > 1) x
  UNION ALL
  SELECT 'uniq job_sources job_id+source_url', count(*) FROM (
    SELECT job_id, source_url FROM job_sources GROUP BY 1, 2 HAVING count(*) > 1) x
  UNION ALL
  SELECT 'uniq email_batches.digest_hash', count(*) FROM (
    SELECT digest_hash FROM email_batches GROUP BY 1 HAVING count(*) > 1) x

  -- The CHECK constraints, restated so that a restore which dropped them is
  -- still looked at by something.
  UNION ALL
  SELECT 'chk jobs.sponsorship_status vocabulary', count(*) FROM jobs
  WHERE sponsorship_status NOT IN ('SUPPORTED', 'UNKNOWN', 'UNSUPPORTED')
  UNION ALL
  SELECT 'chk jobs.status vocabulary', count(*) FROM jobs WHERE status NOT IN ('OPEN', 'CLOSED')
  UNION ALL
  SELECT 'chk jobs.graduation_claim vocabulary', count(*) FROM jobs
  WHERE graduation_claim IS NOT NULL
    AND graduation_claim NOT IN ('JUNE_2027', 'DECEMBER_2027', 'JUNE_2028')
  UNION ALL
  SELECT 'chk source_runs.status vocabulary', count(*) FROM source_runs
  WHERE status NOT IN ('RUNNING', 'SUCCESS', 'DEGRADED', 'FAILED', 'SKIPPED')
  UNION ALL
  SELECT 'chk email_batches.status vocabulary', count(*) FROM email_batches
  WHERE status NOT IN ('CLAIMED', 'SENT', 'ABANDONED')
  UNION ALL
  SELECT 'chk watchlist_states.state vocabulary', count(*) FROM watchlist_states
  WHERE state NOT IN ('OPEN', 'ANNOUNCED', 'EXPECTED', 'NO_SIGNAL', 'CLOSED')
  UNION ALL
  SELECT 'chk applied_exclusions.kind vocabulary', count(*) FROM applied_exclusions
  WHERE kind NOT IN ('APPLIED', 'INELIGIBLE', 'DUPLICATE')
  UNION ALL
  SELECT 'chk employer_h1b_approvals positive', count(*) FROM employer_h1b_approvals WHERE approvals <= 0
  UNION ALL
  SELECT 'chk sponsorship_overrides identify a posting', count(*) FROM sponsorship_overrides
  WHERE source_job_id IS NULL AND canonical_url IS NULL

  -- Shapes the application reads back without checking.
  UNION ALL
  SELECT 'jobs.required_skills is a json array', count(*) FROM jobs
  WHERE jsonb_typeof(required_skills) <> 'array'
  UNION ALL
  SELECT 'job_enrichment.skills is a json array', count(*) FROM job_enrichment
  WHERE jsonb_typeof(skills) <> 'array'
)
SELECT name, offending, CASE WHEN offending = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM checks ORDER BY name;
