-- The graduation date a posting's resume should claim. Computed every run, but
-- a resume build happens after the run, so it has to survive somewhere.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS graduation_claim text
  CHECK (graduation_claim IN ('JUNE_2027', 'JUNE_2028'));
