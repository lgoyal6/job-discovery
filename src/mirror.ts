import { config } from './config.js';
import { getJobsToMirror, recordNotionPage } from './db.js';
import { log } from './logger.js';
import { createLedgerPage } from './notion.js';

export interface MirrorResult { attempted: number; created: number; failed: number }

// Notion allows about three requests a second per integration and answers 429
// past that. The writes are serial with a gap rather than concurrent: a mirror
// is bookkeeping behind a digest, and there is nothing to be gained by racing
// the rate limiter for it.
const WRITE_INTERVAL_MS = 350;

/**
 * Writes a page into the Notion ledger for every role that does not have one.
 *
 * Never throws. The digest is the product and Notion is a record of it, so a
 * workspace that is down, rate limiting, or missing its integration must cost
 * the run its mirror and nothing else. A page id is stored the moment a page
 * exists, so a run that dies halfway does not rewrite what it already wrote.
 */
export async function mirrorNewPostings(runId: string): Promise<MirrorResult> {
  const result: MirrorResult = { attempted: 0, created: 0, failed: 0 };
  if (!config.NOTION_MIRROR_ENABLED || !config.NOTION_TOKEN) return result;

  let pending: Awaited<ReturnType<typeof getJobsToMirror>>;
  try {
    pending = await getJobsToMirror(config.NOTION_MIRROR_MAX_PER_RUN);
  } catch (error) {
    log('error', 'notion_mirror_failed', { runId, error: error instanceof Error ? error.message : String(error) });
    return result;
  }
  if (!pending.length) return result;

  const startedAt = Date.now();
  for (const job of pending) {
    result.attempted += 1;
    try {
      const pageId = await createLedgerPage(job, config.NOTION_MIRROR_STATUS);
      await recordNotionPage(job.id, pageId);
      result.created += 1;
    } catch (error) {
      result.failed += 1;
      // One bad row must not cost the rest of the batch, but a workspace that
      // is refusing everything should not be asked two hundred times.
      log('warn', 'notion_mirror_page_failed', { runId, jobId: job.id, error: error instanceof Error ? error.message : String(error) });
      if (result.failed >= 5 && result.created === 0) {
        log('error', 'notion_mirror_abandoned', { runId, attempted: result.attempted });
        break;
      }
    }
    await new Promise(resolve => setTimeout(resolve, WRITE_INTERVAL_MS));
  }
  log('info', 'notion_mirror_complete', { runId, ...result, remaining: pending.length - result.attempted, durationMs: Date.now() - startedAt });
  return result;
}
