-- Employer-level H-1B approval counts, used as a NEGATIVE signal only.
--
-- sponsorship_overrides cannot carry this: its CHECK requires a source_job_id
-- or a canonical_url, so it is per-posting by construction. This table is
-- per-employer and answers a different question: when a posting says nothing
-- about sponsorship, has this employer ever sponsored anyone?
--
-- Absence is the signal, not the count. A company with 3 approvals still
-- sponsors. A company with none, in two full fiscal years, probably does not.
CREATE TABLE IF NOT EXISTS employer_h1b_approvals (
  company_normalized text PRIMARY KEY,
  approvals integer NOT NULL CHECK (approvals > 0),
  fiscal_years int[] NOT NULL,
  source text NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now()
);
