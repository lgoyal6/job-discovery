-- Enrichment already fetched the posting's full text to read a sponsorship
-- verdict out of it, then dropped the text. In one live run that left 92% of
-- digest roles reading "Required skills: Not stated" and 82% with no summary,
-- every one of them from a page this pipeline had already downloaded and read.
--
-- Skills are worth up to 15 points, so the same requisition scored 116 arriving
-- from Monster with a description and 91 from a community list without one.
-- Keeping the text's useful parts here closes that gap without another fetch,
-- and without a paid source whose only advantage was carrying prose.
--
-- Kept alongside the verdict rather than on jobs, for the reason 003 gives:
-- upsertJob rewrites the jobs row from source data every run, so anything
-- recovered by reading the page would be erased on the next tick.
ALTER TABLE job_enrichment ADD COLUMN IF NOT EXISTS skills jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE job_enrichment ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '';
