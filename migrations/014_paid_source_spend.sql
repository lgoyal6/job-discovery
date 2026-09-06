-- What the paid sources cost, and whether the money bought anything.
--
-- `source_runs.cost_units` has existed since the first migration and every
-- writer in the tree passes the literal 0, so a Monster actor run that charges
-- about $0.49 against a $5 monthly credit was recorded as free. Worse, a run
-- whose socket timed out was recorded as FAILED with the same 0 while the actor
-- stayed up on Apify's side and kept billing to its own cap.
--
-- Append-only, one row per event, never updated in place. A mistake is
-- corrected by writing another row, so the history of a month's spend can be
-- replayed rather than trusted.
--
-- run_key is the idempotency key: one actor call, however many times the
-- pipeline reaches the ledger about it. The unique index is what makes a retry
-- cost nothing, and it is a database constraint rather than a check in the
-- application because two pipeline runs can overlap.
CREATE TABLE IF NOT EXISTS paid_source_spend (
  id          bigserial PRIMARY KEY,
  run_key     text NOT NULL,
  source_name text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('RESERVE', 'SETTLE', 'RELEASE', 'ABANDONED')),
  -- Millionths of a dollar. Integer, because 0.1 + 0.2 is 0.30000000000000004
  -- and a ledger that drifts is a ledger nobody trusts.
  micros      bigint NOT NULL CHECK (micros >= 0),
  period      text NOT NULL,
  -- Whether the amount is a measurement or the ceiling we authorised.
  -- run-sync-get-dataset-items returns the dataset and no usage figure, so a
  -- completed run's cost is known only as "at most what we authorised". Saying
  -- which is the difference between a ledger and a guess.
  measured    boolean NOT NULL DEFAULT true,
  note        text NOT NULL DEFAULT '',
  at          timestamptz NOT NULL DEFAULT now()
);

-- One RESERVE per call, and one closing row per call. Both directions of the
-- double-charge are refused by the database rather than by whoever remembers.
CREATE UNIQUE INDEX IF NOT EXISTS paid_source_spend_reserve_once
  ON paid_source_spend(run_key) WHERE kind = 'RESERVE';
CREATE UNIQUE INDEX IF NOT EXISTS paid_source_spend_closed_once
  ON paid_source_spend(run_key) WHERE kind IN ('SETTLE', 'ABANDONED');

-- The read every reserve does: what has this month already committed.
CREATE INDEX IF NOT EXISTS paid_source_spend_period_idx ON paid_source_spend(period);
