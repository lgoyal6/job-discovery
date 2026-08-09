-- Program and early-careers pages watched for change.
--
-- The pipeline can only surface a role once a requisition exists. Employers
-- announce a cycle on a program page weeks earlier ("technology applications
-- open in July"), and that lead time is worth more than finding the posting on
-- day one. Hashing the page's extracted text turns that announcement into a
-- signal without needing a model to read the page.
CREATE TABLE IF NOT EXISTS page_watches (
  url text PRIMARY KEY,
  company text NOT NULL,
  label text NOT NULL DEFAULT '',
  content_hash text NOT NULL DEFAULT '',
  text_length integer NOT NULL DEFAULT 0,
  -- Records the attempt as well as the content, so a page that starts 403ing
  -- is visible as a stalled watch rather than as an absence of changes.
  http_ok boolean NOT NULL DEFAULT false,
  last_error text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  last_changed_at timestamptz
);

CREATE INDEX IF NOT EXISTS page_watches_changed_idx ON page_watches(last_changed_at DESC);
