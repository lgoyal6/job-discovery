-- The fingerprint a restore has to reproduce: timestamps to the microsecond,
-- content digests, and the schema the database is still enforcing.
--
-- Timestamps get their own lines because "the rows came back" and "the rows
-- came back carrying the instants they were written at" are different claims.
-- Every timestamptz here has a now() default somewhere behind it, so a restore
-- that re-defaulted one satisfies a row count and fails this.
\pset footer off
\t on
\a
\f '='

SELECT 'jobs.count', count(*)::text FROM jobs
UNION ALL SELECT 'jobs.first_seen_at.min', coalesce(min(first_seen_at)::text, '-') FROM jobs
UNION ALL SELECT 'jobs.first_seen_at.max', coalesce(max(first_seen_at)::text, '-') FROM jobs
UNION ALL SELECT 'jobs.last_seen_at.max', coalesce(max(last_seen_at)::text, '-') FROM jobs
UNION ALL SELECT 'jobs.sent_at.min', coalesce(min(sent_at)::text, '-') FROM jobs
UNION ALL SELECT 'jobs.sent_at.max', coalesce(max(sent_at)::text, '-') FROM jobs
UNION ALL SELECT 'jobs.sent.count', count(*)::text FROM jobs WHERE sent_at IS NOT NULL
UNION ALL SELECT 'jobs.closed_at.max', coalesce(max(closed_at)::text, '-') FROM jobs
UNION ALL SELECT 'jobs.updated_at.max', coalesce(max(updated_at)::text, '-') FROM jobs
UNION ALL SELECT 'jobs.canonical_key.agg', coalesce(md5(string_agg(canonical_key, ',' ORDER BY canonical_key)), '-') FROM jobs
UNION ALL SELECT 'jobs.fingerprint.agg', coalesce(md5(string_agg(material_fingerprint, ',' ORDER BY canonical_key)), '-') FROM jobs
UNION ALL SELECT 'jobs.material_version.sum', coalesce(sum(material_version)::text, '-') FROM jobs
UNION ALL SELECT 'jobs.score.sum', coalesce(sum(score)::text, '-') FROM jobs
UNION ALL SELECT 'jobs.row.agg', coalesce(md5(string_agg(
    canonical_key||'|'||company||'|'||normalized_company||'|'||title||'|'||normalized_title||'|'
    ||location||'|'||normalized_location||'|'||cycle||'|'||category||'|'||sponsorship_status||'|'
    ||status||'|'||score::text||'|'||required_skills::text||'|'||coalesce(graduation_claim,'-'),
    E'\n' ORDER BY canonical_key)), '-') FROM jobs

UNION ALL SELECT 'job_sources.count', count(*)::text FROM job_sources
UNION ALL SELECT 'job_sources.scraped_at.max', coalesce(max(scraped_at)::text, '-') FROM job_sources
UNION ALL SELECT 'job_sources.posted_at.min', coalesce(min(posted_at)::text, '-') FROM job_sources
UNION ALL SELECT 'job_sources.url.agg', coalesce(md5(string_agg(source_url, ',' ORDER BY source_url)), '-') FROM job_sources

UNION ALL SELECT 'job_enrichment.count', count(*)::text FROM job_enrichment
UNION ALL SELECT 'job_enrichment.fetched_at.max', coalesce(max(fetched_at)::text, '-') FROM job_enrichment
UNION ALL SELECT 'job_enrichment.http_ok.false', count(*)::text FROM job_enrichment WHERE NOT http_ok

UNION ALL SELECT 'email_batches.count', count(*)::text FROM email_batches
UNION ALL SELECT 'email_batches.sent.count', count(*)::text FROM email_batches WHERE status = 'SENT'
UNION ALL SELECT 'email_batches.claimed_at.max', coalesce(max(claimed_at)::text, '-') FROM email_batches
UNION ALL SELECT 'email_batches.sent_at.max', coalesce(max(sent_at)::text, '-') FROM email_batches
UNION ALL SELECT 'email_batches.digest_hash.agg', coalesce(md5(string_agg(digest_hash, ',' ORDER BY digest_hash)), '-') FROM email_batches
UNION ALL SELECT 'email_batches.job_ids.agg', coalesce(md5(string_agg(x.ids, E'\n' ORDER BY x.ids)), '-')
  FROM (SELECT array_to_string(job_ids, ',') AS ids FROM email_batches) x

UNION ALL SELECT 'source_runs.count', count(*)::text FROM source_runs
UNION ALL SELECT 'source_runs.started_at.max', coalesce(max(started_at)::text, '-') FROM source_runs
UNION ALL SELECT 'page_watches.count', count(*)::text FROM page_watches
UNION ALL SELECT 'page_watches.last_checked_at.max', coalesce(max(last_checked_at)::text, '-') FROM page_watches
UNION ALL SELECT 'applied_exclusions.count', count(*)::text FROM applied_exclusions
UNION ALL SELECT 'applied_exclusions.synced_at.max', coalesce(max(synced_at)::text, '-') FROM applied_exclusions
UNION ALL SELECT 'employer_h1b_approvals.count', count(*)::text FROM employer_h1b_approvals
UNION ALL SELECT 'employer_h1b_approvals.sum', coalesce(sum(approvals)::text, '-') FROM employer_h1b_approvals
UNION ALL SELECT 'watchlist_states.count', count(*)::text FROM watchlist_states
UNION ALL SELECT 'company_aliases.count', count(*)::text FROM company_aliases
UNION ALL SELECT 'sponsorship_overrides.count', count(*)::text FROM sponsorship_overrides

UNION ALL SELECT 'schema.migrations', coalesce(string_agg(version, ',' ORDER BY version), '-') FROM schema_migrations
UNION ALL SELECT 'schema.constraint_count', count(*)::text
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace
UNION ALL SELECT 'schema.constraints', md5(string_agg(conname||' '||pg_get_constraintdef(oid), E'\n' ORDER BY conname))
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace
UNION ALL SELECT 'schema.indexes', md5(string_agg(indexdef, E'\n' ORDER BY indexname))
  FROM pg_indexes WHERE schemaname = 'public';
