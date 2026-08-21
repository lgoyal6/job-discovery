import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { config, projectRoot } from './config.js';
import { extractText } from './enrichment.js';
import type { ClassifiedJob, DigestJob, SourceResult } from './types.js';
import type { AppliedExclusion } from './notion.js';
import { batchKey as makeBatchKey, digestHash as makeDigestHash } from './state.js';
import { materialFingerprint } from './normalization.js';

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000 });

export async function migrate(): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await readdir(resolve(projectRoot, 'migrations'))).filter(file => file.endsWith('.sql')).sort();
    for (const file of files) {
      const exists = await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file]);
      if (exists.rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(await readFile(resolve(projectRoot, 'migrations', file), 'utf8'));
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
    return applied;
  } finally { client.release(); }
}

export async function withPipelineLock<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const lockId = 753_920_271;
  try {
    const lock = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1) AS acquired', [lockId]);
    if (!lock.rows[0]?.acquired) throw new Error('A job-discovery pipeline run is already active.');
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => undefined);
    client.release();
  }
}

export async function syncAppliedExclusions(exclusions: AppliedExclusion[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM applied_exclusions');
    for (const item of exclusions) await client.query(
      `INSERT INTO applied_exclusions(notion_page_id,company_normalized,title_normalized,canonical_url,source_job_id)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(notion_page_id) DO UPDATE SET company_normalized=EXCLUDED.company_normalized,title_normalized=EXCLUDED.title_normalized,canonical_url=EXCLUDED.canonical_url,source_job_id=EXCLUDED.source_job_id,synced_at=now()`,
      [item.notionPageId, item.companyNormalized, item.titleNormalized, item.canonicalUrl ?? null, item.sourceJobId ?? null]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function loadCachedAppliedExclusions(): Promise<AppliedExclusion[]> {
  const rows = await pool.query<{ notion_page_id: string; company_normalized: string; title_normalized: string; canonical_url: string | null; source_job_id: string | null }>('SELECT notion_page_id,company_normalized,title_normalized,canonical_url,source_job_id FROM applied_exclusions');
  return rows.rows.map(row => ({ notionPageId: row.notion_page_id, companyNormalized: row.company_normalized, titleNormalized: row.title_normalized, canonicalUrl: row.canonical_url ?? undefined, sourceJobId: row.source_job_id ?? undefined }));
}

export async function recordAppliedExclusion(exclusion: AppliedExclusion): Promise<void> {
  await pool.query(
    `INSERT INTO applied_exclusions(notion_page_id,company_normalized,title_normalized,canonical_url,source_job_id)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT(notion_page_id) DO UPDATE SET company_normalized=EXCLUDED.company_normalized,title_normalized=EXCLUDED.title_normalized,canonical_url=EXCLUDED.canonical_url,source_job_id=EXCLUDED.source_job_id,synced_at=now()`,
    [exclusion.notionPageId, exclusion.companyNormalized, exclusion.titleNormalized, exclusion.canonicalUrl ?? null, exclusion.sourceJobId ?? null]);
}

export interface LedgerJob {
  id: string; company: string; title: string; url: string; sourceJobId?: string; notionPageId?: string;
  location?: string; cycle?: string; category?: string; sponsorshipStatus?: string; skills?: string[]; postedAt?: string; summary?: string;
}

// One shape for both callers, because a row the mirror files and a row the
// applied click files have to carry the same columns.
const LEDGER_COLUMNS = `j.id, j.company, j.title, j.location, j.cycle, j.category, j.sponsorship_status, j.required_skills, j.description, j.notion_page_id,
       s.url, s.source_job_id, s.posted_at`;
const LEDGER_JOIN = `LEFT JOIN LATERAL (
         SELECT COALESCE(NULLIF(direct_apply_url,''), source_url) AS url, source_job_id, posted_at
           FROM job_sources WHERE job_id = j.id ORDER BY updated_at DESC LIMIT 1
       ) s ON true`;

interface LedgerRow {
  id: string; company: string; title: string; location: string | null; cycle: string | null; category: string | null;
  sponsorship_status: string | null; required_skills: unknown; description: string | null; notion_page_id: string | null;
  url: string | null; source_job_id: string | null; posted_at: Date | null;
}

function toLedgerJob(row: LedgerRow): LedgerJob {
  return {
    id: row.id, company: row.company, title: row.title, url: row.url ?? '',
    sourceJobId: row.source_job_id ?? undefined, notionPageId: row.notion_page_id ?? undefined,
    location: row.location ?? undefined, cycle: row.cycle ?? undefined, category: row.category ?? undefined,
    sponsorshipStatus: row.sponsorship_status ?? undefined,
    skills: Array.isArray(row.required_skills) ? row.required_skills as string[] : [],
    postedAt: row.posted_at ? row.posted_at.toISOString() : undefined,
    // Greenhouse stores its description as HTML, so the ledger would otherwise
    // get a column of markup. Same stripper the enrichment reader uses.
    summary: row.description ? extractText(row.description).slice(0, 1900) : undefined
  };
}

/**
 * The roles that still owe the ledger a page: eligible, open, and never
 * mirrored. Oldest first, so a backlog drains in the order it arrived rather
 * than starving behind whatever is newest.
 */
export async function getJobsToMirror(limit: number): Promise<LedgerJob[]> {
  if (limit <= 0) return [];
  const rows = await pool.query<LedgerRow>(
    `SELECT ${LEDGER_COLUMNS} FROM jobs j ${LEDGER_JOIN}
      WHERE j.notion_page_id IS NULL AND j.status='OPEN'
      ORDER BY j.first_seen_at LIMIT $1`, [limit]);
  return rows.rows.map(toLedgerJob);
}

export async function recordNotionPage(jobId: string, notionPageId: string): Promise<void> {
  await pool.query('UPDATE jobs SET notion_page_id=$2, updated_at=now() WHERE id=$1', [jobId, notionPageId]);
}

// The ledger wants what a human reads in the digest row, so the URL is the one
// the digest linked: the direct application if the role has one, its source
// listing otherwise.
export async function getJobForLedger(jobId: string): Promise<LedgerJob | undefined> {
  const rows = await pool.query<LedgerRow>(`SELECT ${LEDGER_COLUMNS} FROM jobs j ${LEDGER_JOIN} WHERE j.id = $1`, [jobId]);
  const row = rows.rows[0];
  return row ? toLedgerJob(row) : undefined;
}

export interface SponsorshipOverrideRow {
  companyNormalized: string;
  sourceJobId?: string;
  canonicalUrl?: string;
  status: 'SUPPORTED' | 'UNKNOWN' | 'UNSUPPORTED';
  evidence: string;
}

export async function loadCompanyAliasRows(): Promise<Array<{ aliasNormalized: string; canonicalCompany: string }>> {
  const rows = await pool.query<{ alias_normalized: string; canonical_company: string }>('SELECT alias_normalized,canonical_company FROM company_aliases');
  return rows.rows.map(row => ({ aliasNormalized: row.alias_normalized, canonicalCompany: row.canonical_company }));
}

export async function loadSponsorshipOverrides(): Promise<SponsorshipOverrideRow[]> {
  const rows = await pool.query<{ company_normalized: string; source_job_id: string | null; canonical_url: string | null; status: SponsorshipOverrideRow['status']; evidence: string }>(
    'SELECT company_normalized,source_job_id,canonical_url,status,evidence FROM sponsorship_overrides WHERE expires_at IS NULL OR expires_at > now()');
  return rows.rows.map(row => ({ companyNormalized: row.company_normalized, sourceJobId: row.source_job_id ?? undefined, canonicalUrl: row.canonical_url ?? undefined, status: row.status, evidence: row.evidence }));
}

export async function recordSourceRuns(runId: string, runs: SourceResult[]): Promise<void> {
  for (const run of runs) {
    await pool.query(
    `INSERT INTO source_runs(pipeline_run_id,source_name,started_at,finished_at,status,fetched_count,accepted_count,rejected_count,duration_ms,error_message,cost_units,metrics)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [runId, run.sourceName, run.startedAt, run.finishedAt, run.status, run.jobs.length, Number(run.metrics?.acceptedCount ?? 0), Number(run.metrics?.rejectedCount ?? 0), run.durationMs, run.error ?? null, run.costUnits, run.metrics ?? {}]);
    if (run.status === 'SUCCESS' && run.metrics?.skippedDueToCadence !== true) {
      const latestPostedAt = run.jobs.map(job => job.postedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? run.finishedAt;
      await pool.query(`INSERT INTO pipeline_watermarks(source_name,watermark) VALUES($1,$2) ON CONFLICT(source_name) DO UPDATE SET watermark=EXCLUDED.watermark,updated_at=now()`, [run.sourceName, { latestPostedAt, lastSuccessfulRunAt: run.finishedAt }]);
    }
  }
}

export async function isSourceDue(sourceName: string, minimumIntervalHours: number, now = new Date()): Promise<boolean> {
  const result = await pool.query<{ updated_at: Date }>('SELECT updated_at FROM pipeline_watermarks WHERE source_name=$1', [sourceName]);
  const lastRun = result.rows[0]?.updated_at;
  return !lastRun || now.getTime() - lastRun.getTime() >= minimumIntervalHours * 3_600_000;
}

export interface UpsertResult { job: DigestJob; isNew: boolean; stateChanged: boolean }

// How long a role must have been absent before its return counts as a repost
// rather than a gap in what the sources happened to sample.
const REPOST_AFTER_DAYS = 30;

export async function upsertJob(job: ClassifiedJob): Promise<UpsertResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fingerprint = materialFingerprint({ title: job.title, location: job.location ?? 'Unspecified', cycle: job.cycle });
    const existing = await client.query<any>(
      `SELECT j.* FROM jobs j
       WHERE j.canonical_key=$1 OR ($2 <> '' AND EXISTS (SELECT 1 FROM job_sources s WHERE s.job_id=j.id AND (s.direct_apply_url=$2 OR s.source_url=$2)))
          OR (j.normalized_company=$3 AND j.normalized_title=$4 AND j.normalized_location=$5 AND j.cycle=$6)
          -- The requisition id, without the source that carried it. A canonical
          -- key prefixes the source name, so the same posting reached through a
          -- board and through a list that links to it produced two rows and a
          -- second email. In-run dedupe has always collapsed these; the database
          -- did not, which is why the repeat appeared a day later rather than in
          -- the same digest. Company-scoped: a Workday R-number is unique only
          -- within its tenant.
          OR ($7 <> '' AND j.normalized_company=$3 AND EXISTS (SELECT 1 FROM job_sources s2 WHERE s2.job_id=j.id AND s2.source_job_id=$7))
       ORDER BY j.first_seen_at LIMIT 1 FOR UPDATE`,
      [job.canonicalKey, job.canonicalUrl, job.normalizedCompany, job.normalizedTitle, job.normalizedLocation, job.cycle, job.sourceJobId ?? '']);
    let id: string;
    let isNew = false;
    let stateChanged = false;
    const nowOpen = job.status !== 'CLOSED';
    if (!existing.rows[0]) {
      isNew = true;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO jobs(canonical_key,company,normalized_company,title,normalized_title,location,normalized_location,cycle,category,sponsorship_status,sponsorship_evidence,description,employment_type,required_skills,score,status,last_verified_at,closed_at,material_fingerprint)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),CASE WHEN $16='CLOSED' THEN now() ELSE NULL END,$17) RETURNING id`,
        [job.canonicalKey, job.company, job.normalizedCompany, job.title, job.normalizedTitle, job.location ?? 'Unspecified', job.normalizedLocation, job.cycle, job.category, job.sponsorshipStatus, job.sponsorshipEvidence, job.description ?? null, job.employmentType ?? null, JSON.stringify(job.requiredSkills), job.score, job.status ?? 'OPEN', fingerprint]);
      id = inserted.rows[0]!.id;
    } else {
      const prior = existing.rows[0]; id = prior.id;
      // A role is only "closed" here because no source happened to carry it for
      // 72 hours, and the board actors sample a capped, rotating slice of a big
      // employer's postings. So a high-volume employer's role drops out, closes,
      // comes back and gets mailed again, on repeat, without anything about it
      // having changed. Only an absence far longer than any sampling gap can
      // explain is treated as a genuine repost worth an email.
      const genuineRepost = prior.status === 'CLOSED' && nowOpen
        && prior.closed_at instanceof Date && prior.closed_at.getTime() < Date.now() - REPOST_AFTER_DAYS * 86_400_000;
      stateChanged = genuineRepost || (Boolean(prior.material_fingerprint) && prior.material_fingerprint !== fingerprint);
      await client.query(
        `UPDATE jobs SET company=$2,normalized_company=$3,title=$4,normalized_title=$5,location=$6,normalized_location=$7,cycle=$8,category=$9,sponsorship_status=$10,sponsorship_evidence=$11,description=COALESCE($12,description),employment_type=COALESCE($13,employment_type),required_skills=$14,score=$15,last_seen_at=now(),last_verified_at=now(),status=$16,
          closed_at=CASE WHEN $16='CLOSED' THEN COALESCE(closed_at,now()) ELSE NULL END,
          reopened_at=CASE WHEN status='CLOSED' AND $16='OPEN' THEN now() ELSE reopened_at END,
          sent_at=CASE WHEN (status='CLOSED' AND $16='OPEN' AND closed_at < now() - make_interval(days => $18::int)) OR (material_fingerprint<>'' AND material_fingerprint<>$17) THEN NULL ELSE sent_at END,
          material_version=CASE WHEN (status='CLOSED' AND $16='OPEN' AND closed_at < now() - make_interval(days => $18::int)) OR (material_fingerprint<>'' AND material_fingerprint<>$17) THEN material_version+1 ELSE material_version END,
          material_fingerprint=$17,updated_at=now() WHERE id=$1`,
        [id, job.company, job.normalizedCompany, job.title, job.normalizedTitle, job.location ?? 'Unspecified', job.normalizedLocation, job.cycle, job.category, job.sponsorshipStatus, job.sponsorshipEvidence, job.description ?? null, job.employmentType ?? null, JSON.stringify(job.requiredSkills), job.score, job.status ?? 'OPEN', fingerprint, REPOST_AFTER_DAYS]);
    }
    await client.query(
      `INSERT INTO job_sources(job_id,source_name,source_job_id,source_url,direct_apply_url,posted_at,scraped_at,verification_status,raw_payload)
       VALUES($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING`,
      [id, job.sourceName, job.sourceJobId ?? '', job.sourceUrl, job.directApplyUrl ?? null, job.postedAt ?? null, job.scrapedAt, job.directApplyUrl ? 'DIRECT_URL' : 'SOURCE_ONLY', JSON.stringify(job.raw ?? {})]);
    // The second branch of this WHERE re-points a source row at the job it now
    // belongs to, so that a list which changed its link refreshes the row it
    // already has instead of growing a second one. Unrestricted, it is also what
    // took the technical digest down for eighteen hours: every community list
    // gives all of its rows the same README as source_url, so the moment a
    // posting migrated from one job row to another, this tried to move
    // (old job, README) onto (this job, README) and hit
    // job_sources_job_id_source_url_key against the row the INSERT above had
    // just created. The transaction rolled back, the run aborted before it could
    // claim an email batch, and because the migration is re-attempted from the
    // same state every two hours it failed identically 10 runs in a row.
    //
    // NOT EXISTS leaves a row where it is rather than moving it onto a collision,
    // and DISTINCT ON keeps the statement from moving two rows that share a
    // source_url onto this job at once, which would collide with each other
    // inside the one statement. The row that is already on this job wins, then
    // the most recently updated one.
    await client.query(
      `UPDATE job_sources SET job_id=$1,direct_apply_url=COALESCE($5,direct_apply_url),posted_at=COALESCE($6,posted_at),scraped_at=$7,verification_status=$8,raw_payload=$9,updated_at=now()
       WHERE id IN (
         SELECT DISTINCT ON (s.source_url) s.id FROM job_sources s
          WHERE ((s.job_id=$1 AND s.source_url=$4) OR (s.source_name=$2 AND s.source_job_id=NULLIF($3,'')))
            AND NOT EXISTS (SELECT 1 FROM job_sources t WHERE t.job_id=$1 AND t.source_url=s.source_url AND t.id<>s.id)
          ORDER BY s.source_url, (s.job_id=$1) DESC, s.updated_at DESC
       )`,
      [id, job.sourceName, job.sourceJobId ?? '', job.sourceUrl, job.directApplyUrl ?? null, job.postedAt ?? null, job.scrapedAt, job.directApplyUrl ? 'DIRECT_URL' : 'SOURCE_ONLY', JSON.stringify(job.raw ?? {})]);
    await client.query('COMMIT');
    return { job: { ...job, id, meaningfulStateChange: stateChanged }, isNew, stateChanged };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function prepareEmailBatch(runId: string, jobs: DigestJob[], subject: string, extraKeys: string[] = []): Promise<{ batchKey: string; claimed: boolean; reclaimed: boolean }> {
  // extraKeys carries non-job contents of the digest (currently changed program
  // pages) so they participate in dedupe exactly like roles: emailed once, and
  // able to justify a send on their own when no new role exists to key on.
  // job_ids is uuid[] and markBatchSent stamps sent_at through it, so only real
  // job ids may go in the column. The extra keys shape identity only.
  const jobIds = jobs.map(job => job.id).filter((id): id is string => Boolean(id)).sort();
  const identity = [...jobIds, ...extraKeys].sort();
  const digestHash = makeDigestHash(identity);
  const batchKey = makeBatchKey(identity, new Date());
  // A SENT batch is never re-claimable. An ABANDONED one is, and so is a claim
  // left stale by a send that died before confirming — otherwise that digest is
  // blocked forever while the pipeline keeps reporting success every run.
  const inserted = await pool.query<{ batch_key: string; reclaimed: boolean }>(
    `INSERT INTO email_batches(batch_key,pipeline_run_id,job_ids,subject,digest_hash) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(digest_hash) DO UPDATE SET pipeline_run_id=EXCLUDED.pipeline_run_id,status='CLAIMED',claimed_at=now()
       WHERE email_batches.status='ABANDONED'
          OR (email_batches.status='CLAIMED'
              AND email_batches.claimed_at < now() - make_interval(mins => $6::int))
     RETURNING batch_key, (xmax <> 0) AS reclaimed`,
    [batchKey, runId, jobIds, subject, digestHash, config.EMAIL_BATCH_STALE_MINUTES]);
  const row = inserted.rows[0];
  // Re-claiming keeps the row's original batch_key, which is hour-stamped and so
  // differs from the one computed above. Return the stored key or batch-sent
  // would target a row that does not exist and never confirm the send.
  return { batchKey: row?.batch_key ?? batchKey, claimed: Boolean(inserted.rowCount), reclaimed: Boolean(row?.reclaimed) };
}

export async function markBatchSent(batchKey: string, providerMessageId?: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ job_ids: string[] }>(
      `UPDATE email_batches SET status='SENT',sent_at=now(),provider_message_id=$2 WHERE batch_key=$1 AND status='CLAIMED' RETURNING job_ids`, [batchKey, providerMessageId ?? null]);
    if (!result.rows[0]) { await client.query('ROLLBACK'); return false; }
    await client.query('UPDATE jobs SET sent_at=now(),updated_at=now() WHERE id=ANY($1::uuid[])', [result.rows[0].job_ids]);
    await client.query('COMMIT'); return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function getUnsentJobIds(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  // A posting that says it cannot sponsor used to be held back here, which made
  // "unsent" mean "queued or quietly rejected". Those roles are now reported in
  // their own digest section, so they are sendable, they get sent_at stamped
  // like anything else, and they leave the queue instead of sitting in it.
  const rows = await pool.query<{ id: string }>(
    `SELECT j.id FROM jobs j
     WHERE j.id = ANY($1::uuid[]) AND j.sent_at IS NULL AND j.status='OPEN'`, [ids]);
  return new Set(rows.rows.map(row => row.id));
}

/**
 * The company, title and cycle of every role already emailed, for the companies
 * in this run.
 *
 * A role can still reach the digest twice under two different database rows:
 * two lists describing one requisition in different words, with different ids
 * and different apply links, match on nothing the upsert can key on. Whether
 * they are the same requisition is a question the digest already answers when
 * it groups rows, so the answer is computed the same way, here, against what
 * has been sent.
 */
export async function getSentRequisitions(companies: string[]): Promise<Array<{ normalizedCompany: string; normalizedTitle: string; cycle: string }>> {
  if (!companies.length) return [];
  const rows = await pool.query<{ normalized_company: string; normalized_title: string; cycle: string }>(
    `SELECT DISTINCT normalized_company, normalized_title, cycle FROM jobs
      WHERE sent_at IS NOT NULL AND normalized_company = ANY($1::text[])`, [companies]);
  return rows.rows.map(row => ({ normalizedCompany: row.normalized_company, normalizedTitle: row.normalized_title, cycle: row.cycle }));
}

export async function closeStaleJobs(): Promise<number> {
  const result = await pool.query(
    `UPDATE jobs j SET status='CLOSED',closed_at=now(),updated_at=now()
     WHERE j.status='OPEN' AND j.last_seen_at < now() - interval '72 hours'
       AND NOT EXISTS (SELECT 1 FROM job_sources s WHERE s.job_id=j.id AND s.scraped_at >= now() - interval '72 hours')`);
  return result.rowCount ?? 0;
}

export interface StoredEnrichment { status: string; evidence: string; httpOk: boolean; skills: string[]; summary: string }

/** Verdicts already recovered, so a posting is fetched at most once. */
export async function getEnrichment(ids: string[]): Promise<Map<string, StoredEnrichment>> {
  if (!ids.length) return new Map();
  const rows = await pool.query<{ job_id: string; status: string; evidence: string; http_ok: boolean; skills: unknown; summary: string }>(
    'SELECT job_id, status, evidence, http_ok, skills, summary FROM job_enrichment WHERE job_id = ANY($1::uuid[])', [ids]);
  return new Map(rows.rows.map(row => [row.job_id, {
    status: row.status, evidence: row.evidence, httpOk: row.http_ok,
    // Cached alongside the verdict, so a posting read on an earlier run still
    // supplies its skills without being fetched again.
    skills: Array.isArray(row.skills) ? row.skills as string[] : [],
    summary: row.summary ?? ''
  }]));
}

export async function saveEnrichment(verdicts: Array<{ jobId: string; status: string; evidence: string; sourceUrl: string; httpOk: boolean; skills?: string[]; summary?: string }>): Promise<number> {
  if (!verdicts.length) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const verdict of verdicts) {
      if (!verdict.jobId) continue;
      await client.query(
        `INSERT INTO job_enrichment(job_id,status,evidence,source_url,http_ok,fetched_at,skills,summary)
         VALUES($1,$2,$3,$4,$5,now(),$6,$7)
         ON CONFLICT(job_id) DO UPDATE SET status=EXCLUDED.status, evidence=EXCLUDED.evidence,
           source_url=EXCLUDED.source_url, http_ok=EXCLUDED.http_ok, fetched_at=now(),
           skills=EXCLUDED.skills, summary=EXCLUDED.summary`,
        [verdict.jobId, verdict.status, verdict.evidence.slice(0, 500), verdict.sourceUrl.slice(0, 1000), verdict.httpOk,
         JSON.stringify(verdict.skills ?? []), (verdict.summary ?? '').slice(0, 500)]);
    }
    await client.query('COMMIT');
    return verdicts.length;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

/** Apply URLs already observed, used to harvest ATS board slugs. */
export async function getSeenApplyUrls(): Promise<Array<{ url: string; company: string }>> {
  const rows = await pool.query<{ url: string; company: string }>(
    `SELECT DISTINCT coalesce(s.direct_apply_url, s.source_url) AS url, j.company
       FROM job_sources s JOIN jobs j ON j.id = s.job_id
      WHERE coalesce(s.direct_apply_url, s.source_url) IS NOT NULL`);
  return rows.rows;
}

export interface PageWatchRow { url: string; contentHash: string; textLength: number }

export async function getPageWatchState(): Promise<Map<string, PageWatchRow>> {
  const rows = await pool.query<{ url: string; content_hash: string; text_length: number }>(
    'SELECT url, content_hash, text_length FROM page_watches');
  return new Map(rows.rows.map(row => [row.url, { url: row.url, contentHash: row.content_hash, textLength: row.text_length }]));
}

export async function savePageWatch(result: { url: string; company: string; label: string; hash: string; textLength: number; httpOk: boolean; error?: string }, changed: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO page_watches(url,company,label,content_hash,text_length,http_ok,last_error,last_checked_at,last_changed_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,now(),CASE WHEN $8 THEN now() ELSE NULL END)
     ON CONFLICT(url) DO UPDATE SET
       company=EXCLUDED.company, label=EXCLUDED.label,
       -- Keep the last good hash when a fetch fails, so recovering from a 403
       -- does not read as a content change.
       content_hash=CASE WHEN EXCLUDED.content_hash <> '' THEN EXCLUDED.content_hash ELSE page_watches.content_hash END,
       text_length=CASE WHEN EXCLUDED.content_hash <> '' THEN EXCLUDED.text_length ELSE page_watches.text_length END,
       http_ok=EXCLUDED.http_ok, last_error=EXCLUDED.last_error, last_checked_at=now(),
       last_changed_at=CASE WHEN $8 THEN now() ELSE page_watches.last_changed_at END`,
    [result.url, result.company, result.label, result.hash, result.textLength, result.httpOk, result.error ?? null, changed]);
}

export function newRunId(): string { return randomUUID(); }
