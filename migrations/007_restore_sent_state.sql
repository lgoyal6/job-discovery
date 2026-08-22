-- Restores sent_at on every role that was emailed and then had that fact erased.
--
-- The material fingerprint is title, location and cycle, and each source wrote
-- its own spelling of all three to the same job row. A requisition carried by
-- three lists therefore flipped between three fingerprints, and every flip
-- cleared sent_at and mailed the role again on the next run. The code no longer
-- does that, but the rows it already wiped stay wiped: 125 of the 228 unsent
-- rows in production had provably been emailed, one of them 25 times, and every
-- one of them was queued to be sent yet again.
--
-- The condition is not a guess. A row is only touched when it appears in an
-- email_batches row whose status is SENT, which is written after the Gmail node
-- confirms delivery, so each one restored is a role that genuinely reached the
-- reader's inbox. sent_at is set to when that email actually went out rather
-- than to now(), so the seven-day resend cooldown measures from the truth.
--
-- Idempotent, like every migration here: it only fills a NULL, so running it
-- again after a legitimate future re-send does not undo that re-send.
UPDATE jobs j
SET sent_at = sent.sent_at
FROM (
  SELECT DISTINCT ON (job_id) job_id, sent_at
  FROM (
    SELECT unnest(b.job_ids)::uuid AS job_id, b.sent_at
    FROM email_batches b
    WHERE b.status = 'SENT' AND b.sent_at IS NOT NULL
  ) AS flattened
  ORDER BY job_id, sent_at DESC
) AS sent
WHERE j.id = sent.job_id AND j.sent_at IS NULL;
