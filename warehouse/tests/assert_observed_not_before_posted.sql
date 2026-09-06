{{ config(severity = 'warn') }}
-- INVARIANT, advisory: a fetch cannot see a posting before it was posted.
-- Warn, not error, because posted_at is the employer's claim relayed by the
-- source and some sources resolve relative dates ("posted 2 days ago") against
-- the wrong clock. A violation is a defect in that source's date handling, not
-- a reason to fail the build, but it must be visible rather than swallowed.
select observation_id, source_name, source_job_id, posted_at, observed_at
from {{ ref('stg_source_observations') }}
where posted_at is not null
  and posted_at > observed_at
