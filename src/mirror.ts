import { activeProfile, config } from './config.js';
import { getJobForLedger, pool } from './db.js';
import { log } from './logger.js';
import { createLedgerPage } from './notion.js';
import { NoLookupError, type OutboxMessage, type Sink } from './outbox.js';
import { claimJobsForMirror, mirrorRelay } from './outbox-mirror.js';

export interface MirrorResult { attempted: number; created: number; failed: number }

// Notion allows about three requests a second per integration and answers 429
// past that. The writes are serial with a gap rather than concurrent: a mirror
// is bookkeeping behind a digest, and there is nothing to be gained by racing
// the rate limiter for it.
const WRITE_INTERVAL_MS = 350;

/**
 * The real ledger, behind the relay's Sink interface.
 *
 * The page body is read at delivery time rather than carried in the message,
 * so a role edited between being claimed and being filed reaches Notion as it
 * currently is, and so the outbox layer never has to import this module's
 * configuration.
 */
class NotionLedgerSink implements Sink {
  constructor(private readonly status: string) {}

  async deliver(message: OutboxMessage): Promise<{ receipt: string; duplicate: boolean }> {
    const jobId = String(message.payload.jobId);
    const job = await getJobForLedger(jobId);
    if (!job) throw new Error(`job ${jobId} disappeared before its page could be filed`);
    return { receipt: await createLedgerPage(job, this.status), duplicate: false };
  }

  /**
   * Notion cannot answer this.
   *
   * It has no idempotency key, and the mirror writes no property that is
   * guaranteed unique per role: Job ID is the source's id and is empty for
   * several adapters. So a delivery whose process died mid-call cannot be
   * settled from here, and the message stays UNKNOWN until somebody looks. That
   * is the honest outcome, and it is the reason the crash tests run against a
   * consumer that does keep an inbox: the mechanism is proved there, and what
   * Notion specifically costs is written down rather than papered over.
   */
  lookup(): Promise<{ receipt: string } | null> {
    return Promise.reject(new NoLookupError());
  }
}

/**
 * Writes a page into the Notion ledger for every role that does not have one.
 *
 * Claiming a role and queueing its page are one transaction; the Notion call
 * happens afterwards, from a message that is already durable. The previous
 * version filed the page first and recorded its id second, so a run killed
 * between the two left a page this database did not know about and the next run
 * filed a duplicate. scripts/outbox-crash.sh runs both versions under a real
 * SIGKILL and counts the pages.
 *
 * Never throws. The digest is the product and Notion is a record of it, so a
 * workspace that is down, rate limiting, or missing its integration must cost
 * the run its mirror and nothing else.
 */
export async function mirrorNewPostings(runId: string): Promise<MirrorResult> {
  const result: MirrorResult = { attempted: 0, created: 0, failed: 0 };
  // The ledger belongs to the technical reader. The finance profile has its own
  // database and its own recipient but shares NOTION_DATABASE_ID, so its first
  // run filed 200 finance postings as pages in someone else's ledger, up to the
  // per-run cap. The applied read was already gated for this reason; the write
  // was not.
  if (activeProfile !== 'technical') return result;
  if (!config.NOTION_MIRROR_ENABLED || !config.NOTION_TOKEN) return result;

  const startedAt = Date.now();
  const relay = mirrorRelay(pool, new NotionLedgerSink(config.NOTION_MIRROR_STATUS), {
    owner: `mirror/${runId}`, batch: config.NOTION_MIRROR_MAX_PER_RUN, pauseMs: WRITE_INTERVAL_MS
  });

  try {
    // Settle last run's casualties before creating more work. A message left
    // INFLIGHT by a killed process becomes UNKNOWN here rather than being
    // retried blind, and against Notion it stays UNKNOWN, which is a number
    // worth watching rather than a page silently filed twice.
    const expired = await relay.expireLeases();
    const settled = await relay.reconcile();
    if (expired || settled.examined) log('warn', 'notion_mirror_recovered', { runId, expired, ...settled });

    await claimJobsForMirror(pool, config.NOTION_MIRROR_MAX_PER_RUN, config.NOTION_MIRROR_STATUS);
    const pass = await relay.once();
    result.attempted = pass.claimed;
    result.created = pass.delivered;
    result.failed = pass.retrying + pass.failed;
  } catch (error) {
    log('error', 'notion_mirror_failed', { runId, error: error instanceof Error ? error.message : String(error) });
    return result;
  }

  log('info', 'notion_mirror_complete', { runId, ...result, durationMs: Date.now() - startedAt });
  return result;
}
