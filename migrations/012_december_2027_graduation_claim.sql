-- Keep the persisted claim vocabulary in lockstep with classifyGraduation.
-- Migration 011 predates the explicit December 2027 classification, so the
-- first matching posting otherwise aborts the scheduled pipeline at upsert.
ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_graduation_claim_check;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_graduation_claim_check
  CHECK (graduation_claim IN ('JUNE_2027', 'DECEMBER_2027', 'JUNE_2028'));
