-- Transactional outbox for the Notion mirror.
--
-- The mirror wrote a page to Notion and then recorded the page id locally, in
-- that order, on two different systems. A run killed between the two left a
-- page in the ledger that this database had no record of, and the next run,
-- seeing notion_page_id still NULL, filed a second page for the same role. The
-- comment on mirrorNewPostings said "a page id is stored the moment a page
-- exists, so a run that dies halfway does not rewrite what it already wrote",
-- which is true of a run that dies BETWEEN roles and false of one that dies
-- inside a role.
--
-- The fix is to stop ordering two writes and start committing one. Claiming a
-- role for mirroring and queueing the page it needs are the same transaction;
-- the relay does the Notion call afterwards and can be killed freely.

-- The claim. A role with this set has a queued message; a role without one does
-- not. The pair is what makes the queue a function of the table rather than a
-- second copy of it.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS mirror_requested_at timestamptz;

CREATE TABLE IF NOT EXISTS outbox (
  id                bigserial PRIMARY KEY,
  -- Derived from the state change (which job), never from the attempt. Every
  -- redelivery of the same role carries the same key, which is the only reason
  -- the consumer can recognise it.
  idempotency_key   text NOT NULL UNIQUE,
  topic             text NOT NULL,
  payload           jsonb NOT NULL,
  -- PENDING   never attempted, or an attempt is known to have failed
  -- INFLIGHT  an attempt was durably recorded and has not reported back
  -- UNKNOWN   the attempting process died; whether the consumer received it is
  --           not knowable here, and nothing in this schema will guess
  -- DELIVERED the consumer acknowledged and its receipt is stored
  -- FAILED    attempts exhausted; the effect has NOT landed
  state             text NOT NULL DEFAULT 'PENDING'
                    CHECK (state IN ('PENDING','INFLIGHT','UNKNOWN','DELIVERED','FAILED')),
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts      integer NOT NULL DEFAULT 10 CHECK (max_attempts > 0),
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  -- A lease and not a lock, because a SIGKILLed process releases nothing and a
  -- locked row would be stranded for good.
  lease_owner       text,
  lease_expires_at  timestamptz,
  last_attempt_at   timestamptz,
  last_error        text,
  resolution        text,
  receipt           text,
  delivered_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'DELIVERED' OR receipt IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS outbox_due_idx        ON outbox(next_attempt_at)  WHERE state = 'PENDING';
CREATE INDEX IF NOT EXISTS outbox_lease_idx      ON outbox(lease_expires_at) WHERE state = 'INFLIGHT';
CREATE INDEX IF NOT EXISTS outbox_unresolved_idx ON outbox(id)               WHERE state = 'UNKNOWN';

-- The mirror queue is now "open, never mirrored, never claimed".
CREATE INDEX IF NOT EXISTS jobs_unclaimed_mirror_idx
  ON jobs(first_seen_at) WHERE notion_page_id IS NULL AND mirror_requested_at IS NULL;
