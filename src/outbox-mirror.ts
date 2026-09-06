import type pg from 'pg';
import { enqueue, mirrorKey, Relay, TOPIC_MIRROR_PAGE, type Crasher, type OutboxMessage, type Sink } from './outbox.js';
import type { LedgerPagePayload } from './outbox-sink.js';

/**
 * The mirror's half of the outbox: claiming roles and recording the pages the
 * relay filed for them.
 *
 * It takes a Pool rather than importing db.ts so the crash harness can drive it
 * against a throwaway database without loading the pipeline's configuration,
 * and so nothing in this file can reach the real one by accident.
 */

export interface ClaimRow { id: string; company: string; title: string; url: string | null }

/**
 * Claims roles for mirroring and queues the page each one needs, in ONE
 * transaction.
 *
 * This is the atomic part. Either a role is claimed and its page is queued, or
 * neither happened; there is no ordering of two writes to get wrong because
 * there is only one write. Crashing immediately after the commit costs nothing
 * but time, which is what the crash tests show.
 */
export async function claimJobsForMirror(
  pool: pg.Pool, limit: number, status: string, crash?: Crasher
): Promise<ClaimRow[]> {
  if (limit <= 0) return [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE SKIP LOCKED so two runs claim disjoint sets rather than
    // blocking on each other and then racing.
    const rows = await client.query<ClaimRow>(
      `SELECT j.id, j.company, j.title,
              COALESCE(NULLIF(s.direct_apply_url,''), s.source_url) AS url
         FROM jobs j
         LEFT JOIN LATERAL (
           SELECT direct_apply_url, source_url FROM job_sources
            WHERE job_id = j.id ORDER BY updated_at DESC LIMIT 1
         ) s ON true
        WHERE j.notion_page_id IS NULL AND j.mirror_requested_at IS NULL AND j.status='OPEN'
        ORDER BY j.first_seen_at
        LIMIT $1
        FOR UPDATE OF j SKIP LOCKED`, [limit]);

    for (const row of rows.rows) {
      await client.query('UPDATE jobs SET mirror_requested_at=now(), updated_at=now() WHERE id=$1', [row.id]);
      const payload: LedgerPagePayload = {
        jobId: row.id, company: row.company, title: row.title, url: row.url, status
      };
      await enqueue(client, mirrorKey(row.id), TOPIC_MIRROR_PAGE, payload);
    }
    await client.query('COMMIT');
    if (crash) crash('after_commit');
    return rows.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/**
 * Builds the relay for the mirror.
 *
 * onDelivered is where the page id lands, and it runs in the same transaction
 * that marks the message delivered. Writing notion_page_id separately would put
 * the dual write back one layer down: a crash between the two would leave a
 * page filed, a message marked done, and no page id here.
 */
export function mirrorRelay(pool: pg.Pool, sink: Sink, options: { leaseMs?: number; crash?: Crasher; owner?: string; batch?: number; pauseMs?: number } = {}): Relay {
  return new Relay({
    pool, sink, owner: options.owner, leaseMs: options.leaseMs, crash: options.crash,
    batch: options.batch, pauseMs: options.pauseMs,
    onDelivered: async (client: pg.PoolClient, message: OutboxMessage, receipt: string) => {
      const jobId = String((message.payload as unknown as LedgerPagePayload).jobId);
      await client.query('UPDATE jobs SET notion_page_id=$2, updated_at=now() WHERE id=$1', [jobId, receipt]);
    }
  });
}

/**
 * The mirror as it was: file the page downstream, then record its id here.
 *
 * Kept, and exported, only so the crash harness can run the bug rather than
 * describe it. Killing a process between the two statements leaves a page that
 * this database has no record of, and the next run files a second one, because
 * notion_page_id is still NULL. Nothing in the pipeline calls this.
 */
export async function mirrorDualWrite(
  pool: pg.Pool, limit: number, status: string, sink: Sink, crash?: Crasher
): Promise<number> {
  const rows = await pool.query<ClaimRow>(
    `SELECT j.id, j.company, j.title,
            COALESCE(NULLIF(s.direct_apply_url,''), s.source_url) AS url
       FROM jobs j
       LEFT JOIN LATERAL (
         SELECT direct_apply_url, source_url FROM job_sources
          WHERE job_id = j.id ORDER BY updated_at DESC LIMIT 1
       ) s ON true
      WHERE j.notion_page_id IS NULL AND j.status='OPEN'
      ORDER BY j.first_seen_at LIMIT $1`, [limit]);

  let created = 0;
  for (const row of rows.rows) {
    const result = await sink.deliver({
      id: 0, idempotencyKey: `legacy:${row.id}:${Date.now()}`, topic: TOPIC_MIRROR_PAGE, attempts: 1,
      payload: { jobId: row.id, company: row.company, title: row.title, url: row.url, status } as unknown as Record<string, unknown>
    });
    // The page exists downstream. This process is the only thing that knows its
    // id, and it is about to stop existing.
    if (crash) crash('after_send');
    await pool.query('UPDATE jobs SET notion_page_id=$2, updated_at=now() WHERE id=$1', [row.id, result.receipt]);
    created += 1;
  }
  return created;
}
