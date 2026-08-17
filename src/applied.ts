import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { getJobForLedger, loadCachedAppliedExclusions, recordAppliedExclusion, recordNotionPage } from './db.js';
import { log } from './logger.js';
import { createLedgerPage, isApplied, setLedgerStatus } from './notion.js';
import { canonicalizeUrl, normalizeText } from './normalization.js';

export interface MarkAppliedResult {
  ok: boolean;
  reason?: 'disabled' | 'bad_signature' | 'unknown_job' | 'notion_failed';
  alreadyApplied?: boolean;
  company?: string;
  title?: string;
  notionPageId?: string;
  error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function signJobId(jobId: string): string {
  return createHmac('sha256', config.MARK_APPLIED_SECRET ?? '').update(jobId).digest('hex').slice(0, 32);
}

export function verifyJobSignature(jobId: string, signature: string): boolean {
  if (!config.MARK_APPLIED_SECRET) return false;
  const expected = Buffer.from(signJobId(jobId));
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

/**
 * The link a digest row carries. A job id alone would be enough for anyone who
 * can read the email - or guess a uuid - to write rows into the ledger, so the
 * id travels with a signature the webhook checks before it does anything.
 */
export function markAppliedUrl(jobId: string | undefined): string | undefined {
  if (!jobId || !config.MARK_APPLIED_SECRET || !config.MARK_APPLIED_BASE_URL) return undefined;
  const url = new URL(config.MARK_APPLIED_BASE_URL);
  url.searchParams.set('job', jobId);
  url.searchParams.set('sig', signJobId(jobId));
  return url.toString();
}

/**
 * Files one role in the Notion ledger as applied.
 *
 * Returns a verdict rather than throwing for anything a click can legitimately
 * hit, so the webhook can answer a browser with a page instead of a stack
 * trace. Repeat clicks are expected - a link in an email gets followed twice,
 * and some mail clients scan links on their own - so an entry already in the
 * ledger is reported as success and written once.
 */
export async function markApplied(jobId: string, signature: string): Promise<MarkAppliedResult> {
  if (!config.MARK_APPLIED_SECRET) return { ok: false, reason: 'disabled' };
  if (!UUID.test(jobId) || !verifyJobSignature(jobId, signature)) return { ok: false, reason: 'bad_signature' };

  const job = await getJobForLedger(jobId);
  if (!job) return { ok: false, reason: 'unknown_job' };

  const candidate = {
    normalizedCompany: normalizeText(job.company),
    normalizedTitle: normalizeText(job.title),
    canonicalUrl: job.url ? canonicalizeUrl(job.url) : '',
    sourceJobId: job.sourceJobId
  };
  if (isApplied(candidate, await loadCachedAppliedExclusions())) {
    log('info', 'mark_applied_duplicate', { jobId, company: job.company });
    return { ok: true, alreadyApplied: true, company: job.company, title: job.title };
  }

  let notionPageId: string;
  try {
    // The mirror may already have filed this role. Moving that page to Applied
    // is the whole point of having stored its id: the alternative is a second
    // row for the same posting, one of them stale, every time.
    if (job.notionPageId) {
      await setLedgerStatus(job.notionPageId, 'Applied');
      notionPageId = job.notionPageId;
    } else {
      notionPageId = await createLedgerPage({ company: job.company, title: job.title, url: job.url, sourceJobId: job.sourceJobId }, 'Applied');
      await recordNotionPage(job.id, notionPageId);
    }
  } catch (error) {
    log('error', 'mark_applied_failed', { jobId, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, reason: 'notion_failed', error: error instanceof Error ? error.message : String(error) };
  }

  // Excluded from the next digest without waiting for the next Notion read, and
  // the row that makes a second click a no-op.
  await recordAppliedExclusion({
    notionPageId,
    companyNormalized: candidate.normalizedCompany,
    titleNormalized: candidate.normalizedTitle,
    canonicalUrl: candidate.canonicalUrl || undefined,
    sourceJobId: candidate.sourceJobId
  });
  log('info', 'mark_applied_recorded', { jobId, notionPageId, company: job.company });
  return { ok: true, company: job.company, title: job.title, notionPageId };
}
