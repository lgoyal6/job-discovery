-- The Notion page a role was mirrored to, so a posting is written to the ledger
-- once rather than on every run, and so marking it applied updates that page
-- instead of filing a second row beside it.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notion_page_id text;

-- The mirror queue is "eligible, open, never mirrored", which is a shrinking
-- slice of a growing table.
CREATE INDEX IF NOT EXISTS jobs_unmirrored_idx ON jobs(first_seen_at) WHERE notion_page_id IS NULL;
