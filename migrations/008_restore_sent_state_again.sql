-- Restores send state a second time, now that nothing erases it again.
--
-- 007 restored 125 rows and set each one's sent_at to when its email actually
-- went out, which for most of them was weeks earlier. That was the honest value
-- and it was also the flaw: the guard in place at the time only protected a row
-- for seven days after it was sent, so every restored row was already past its
-- own window the moment it was written, and the next fingerprint flip cleared it
-- again. The digest that followed carried 26 roles the reader had already been
-- sent, and 10 more were queued behind them.
--
-- A fingerprint change no longer clears sent_at at all; only a genuine repost
-- does, which is unambiguous and rare. So the same restore is safe to run now
-- in a way it was not then, and this is the last time it should be needed.
--
-- Same condition as 007: a row is only touched when it appears in an
-- email_batches row whose status is SENT, which is written after the Gmail node
-- confirms delivery. Idempotent, filling only a NULL.
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
