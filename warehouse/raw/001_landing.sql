-- The landing zone: append-only, and the only place raw content is allowed to
-- live. The operational database this warehouse models rewrites jobs and
-- job_sources in place on every pass (see migrations/001 and the comment on
-- migrations/013), so it cannot answer "what did this source say on Tuesday".
-- Landing is where that answer is kept.
--
-- Three clocks, never collapsed into one:
--   posted_at   what the employer claims about when the requisition went live
--   observed_at when a fetch saw this content
--   ingested_at when the row reached the warehouse
-- A late correction is exactly a row whose ingested_at is far later than its
-- observed_at, and every incremental cursor in this project has to survive that.

CREATE SCHEMA IF NOT EXISTS raw;

-- The generated sample file, staged whole. Landing draws from it one batch at
-- a time so a run can be replayed in the order it really happened.
CREATE TABLE IF NOT EXISTS raw.sample_source_observations (
  observation_id          text PRIMARY KEY,
  batch_id                integer NOT NULL,
  source_name             text NOT NULL,
  source_job_id           text NOT NULL,
  revision                integer NOT NULL,
  observed_at             timestamptz NOT NULL,
  posted_at               timestamptz,
  ingested_at             timestamptz NOT NULL,
  corrects_observation_id text NOT NULL DEFAULT '',
  correction_reason       text NOT NULL DEFAULT '',
  company                 text NOT NULL,
  title                   text NOT NULL,
  location                text NOT NULL,
  cycle                   text NOT NULL,
  category                text NOT NULL,
  posting_status          text NOT NULL,
  sponsorship_status      text NOT NULL,
  graduation_eligible     boolean NOT NULL,
  requirements            text NOT NULL DEFAULT '',
  source_url              text NOT NULL,
  canonical_key_hint      text NOT NULL
);

CREATE TABLE IF NOT EXISTS raw.sample_application_status_events (
  event_id      text PRIMARY KEY,
  batch_id      integer NOT NULL,
  canonical_key text NOT NULL,
  from_status   text NOT NULL DEFAULT '',
  to_status     text NOT NULL,
  recorded_at   timestamptz NOT NULL,
  ingested_at   timestamptz NOT NULL,
  evidence      text NOT NULL DEFAULT ''
);

-- GRAIN 1: one source observation per fetch, plus its restatements.
-- (source_name, source_job_id, observed_at) identifies the fetch. revision
-- distinguishes a correction to that fetch from the original reading of it. A
-- correction never updates the row it corrects; it lands beside it.
CREATE TABLE IF NOT EXISTS raw.source_observations (
  LIKE raw.sample_source_observations INCLUDING ALL
);
ALTER TABLE raw.source_observations
  DROP CONSTRAINT IF EXISTS source_observations_fetch_revision_key;
ALTER TABLE raw.source_observations
  ADD CONSTRAINT source_observations_fetch_revision_key
  UNIQUE (source_name, source_job_id, observed_at, revision);
ALTER TABLE raw.source_observations
  DROP CONSTRAINT IF EXISTS source_observations_status_check;
ALTER TABLE raw.source_observations
  ADD CONSTRAINT source_observations_status_check
  CHECK (posting_status IN ('OPEN','CLOSED'));
ALTER TABLE raw.source_observations
  DROP CONSTRAINT IF EXISTS source_observations_sponsorship_check;
ALTER TABLE raw.source_observations
  ADD CONSTRAINT source_observations_sponsorship_check
  CHECK (sponsorship_status IN ('SUPPORTED','UNKNOWN','UNSUPPORTED'));
-- The ingestion clock is the incremental cursor, so it is the index that
-- matters. Nothing here is indexed on observed_at on purpose: an observed_at
-- cursor is the bug this project exists to demonstrate.
CREATE INDEX IF NOT EXISTS source_observations_ingested_idx
  ON raw.source_observations (ingested_at);

-- GRAIN 3: one recorded application-status transition. Append-only. The
-- tracker's current status is a projection of these rows, never a column that
-- gets overwritten, because "when did this become Applied" is a question the
-- operational schema cannot answer at all.
CREATE TABLE IF NOT EXISTS raw.application_status_events (
  LIKE raw.sample_application_status_events INCLUDING ALL
);
CREATE INDEX IF NOT EXISTS application_status_events_ingested_idx
  ON raw.application_status_events (ingested_at);
