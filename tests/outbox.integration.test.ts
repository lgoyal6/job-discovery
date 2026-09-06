import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueue, mirrorKey, Relay, TOPIC_MIRROR_PAGE, NoLookupError, type Sink } from '../src/outbox.js';
import { claimJobsForMirror, mirrorRelay } from '../src/outbox-mirror.js';
import { LedgerSink } from '../src/outbox-sink.js';

// Needs two throwaway databases, because "the page and the inbox row commit
// together" is a claim about a transaction and there is nothing to test without
// one. Never point these at the real pipeline database; the suite truncates
// jobs on every test.
//
//   C13_DB=postgres://.../throwaway C13_SINK_DB=postgres://.../sink \
//     npx vitest run tests/outbox.integration.test.ts
//
// The crash half of C13 is scripts/outbox-crash.sh, which kills real processes;
// a test runner cannot SIGKILL itself and keep asserting.
const dbUrl = process.env.C13_DB;
const sinkUrl = process.env.C13_SINK_DB;
const enabled = Boolean(dbUrl && sinkUrl);

describe.skipIf(!enabled)('the mirror outbox', () => {
  const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
  const sinkPool = new pg.Pool({ connectionString: sinkUrl, max: 4 });
  const sink = new LedgerSink(sinkPool, true);

  /** A sink that records the effect but never acknowledges it. */
  const deafSink = (inner: LedgerSink): Sink => ({
    async deliver(message) { await inner.apply(message.idempotencyKey, message.topic, message.payload as never); throw new Error('the acknowledgement was lost'); },
    lookup: (key: string) => inner.receipt(key).then(receipt => (receipt ? { receipt } : null))
  });
  const realSink: Sink = {
    deliver: message => sink.apply(message.idempotencyKey, message.topic, message.payload as never),
    lookup: key => sink.receipt(key).then(receipt => (receipt ? { receipt } : null))
  };

  afterAll(async () => { await pool.end(); await sinkPool.end(); });

  beforeEach(async () => {
    await sink.migrate();
    await pool.query('TRUNCATE outbox');
    await pool.query('DELETE FROM job_sources');
    await pool.query('DELETE FROM jobs');
    await sinkPool.query('TRUNCATE ledger_pages, inbox CASCADE');
  });

  async function seed(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO jobs(id, canonical_key, company, normalized_company, title, normalized_title,
                          normalized_location, cycle, category, sponsorship_status, status, first_seen_at)
         VALUES($1,$2,$3,$4,$5,$6,'unspecified','Summer 2026','SWE','UNKNOWN','OPEN',
                now() + make_interval(secs => $7::double precision))`,
        [id, `fx-${id}`, `Fixture Co ${index}`, `fixture co ${index}`, `Fixture Engineer ${index}`, `fixture engineer ${index}`, index]);
      await pool.query(
        `INSERT INTO job_sources(job_id, source_name, source_job_id, source_url, scraped_at)
         VALUES($1,'fixtures',$2,$3, now())`, [id, `fx-${index}`, `https://example.invalid/${index}`]);
      ids.push(id);
    }
    return ids;
  }

  const pages = async (jobId: string): Promise<number> =>
    Number((await sinkPool.query('SELECT count(*) FROM ledger_pages WHERE job_id=$1', [jobId])).rows[0].count);
  const row = async (jobId: string): Promise<{ state: string; resolution: string | null; attempts: number }> =>
    (await pool.query('SELECT state, resolution, attempts FROM outbox WHERE idempotency_key=$1', [mirrorKey(jobId)])).rows[0];
  const pageId = async (jobId: string): Promise<string | null> =>
    (await pool.query<{ notion_page_id: string | null }>('SELECT notion_page_id FROM jobs WHERE id=$1', [jobId])).rows[0]?.notion_page_id ?? null;

  // The claim and the message are one write. Rolling back must leave neither.
  it('claims a role and queues its page in one transaction, or neither', async () => {
    const [jobId] = await seed(1);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE jobs SET mirror_requested_at=now() WHERE id=$1', [jobId]);
      await enqueue(client, mirrorKey(jobId!), TOPIC_MIRROR_PAGE, { jobId });
      await client.query('ROLLBACK');
    } finally { client.release(); }

    expect(Number((await pool.query('SELECT count(*) FROM outbox')).rows[0].count)).toBe(0);
    expect((await pool.query('SELECT mirror_requested_at FROM jobs WHERE id=$1', [jobId])).rows[0].mirror_requested_at).toBeNull();
  });

  it('files one page however many times the message is delivered', async () => {
    const [jobId] = await seed(1);
    await claimJobsForMirror(pool, 10, 'Found');
    const relay = mirrorRelay(pool, realSink);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await relay.once();
      await pool.query(`UPDATE outbox SET state='PENDING', next_attempt_at=now(), receipt=NULL, delivered_at=NULL WHERE state='DELIVERED'`);
    }
    expect(await pages(jobId!)).toBe(1);
    // If this were 1 the test would be passing because nothing was redelivered,
    // not because the inbox suppressed anything.
    const deliveries = Number((await sinkPool.query('SELECT deliveries FROM inbox WHERE idempotency_key=$1', [mirrorKey(jobId!)])).rows[0].deliveries);
    expect(deliveries).toBe(4);
  });

  it('claims a role once, so a second run queues nothing for it', async () => {
    const [jobId] = await seed(1);
    expect((await claimJobsForMirror(pool, 10, 'Found'))).toHaveLength(1);
    expect((await claimJobsForMirror(pool, 10, 'Found'))).toHaveLength(0);
    expect(Number((await pool.query('SELECT count(*) FROM outbox WHERE idempotency_key=$1', [mirrorKey(jobId!)])).rows[0].count)).toBe(1);
  });

  // A dead attempt must not be assumed undelivered. PENDING here would be the
  // silent guess the whole state exists to prevent.
  it('turns an expired lease into UNKNOWN and not into PENDING', async () => {
    const [jobId] = await seed(1);
    await claimJobsForMirror(pool, 10, 'Found');
    await pool.query(`UPDATE outbox SET state='INFLIGHT', attempts=1, lease_owner='ghost',
                             lease_expires_at = now() - interval '1 second'`);
    expect(await mirrorRelay(pool, realSink).expireLeases()).toBe(1);
    expect((await row(jobId!)).state).toBe('UNKNOWN');
  });

  // The two ambiguous crashes leave identical rows here. Only the consumer can
  // tell them apart, and reconcile must reach the opposite conclusion in each.
  it('settles an ambiguous outcome in whichever direction the consumer reports', async () => {
    const [absent, applied] = await seed(2);
    await claimJobsForMirror(pool, 10, 'Found');
    // The second one reached the consumer; the acknowledgement did not come back.
    const deaf = mirrorRelay(pool, deafSink(sink), { batch: 1 });
    await pool.query(`UPDATE outbox SET next_attempt_at = now() + interval '1 hour'
                       WHERE idempotency_key <> $1`, [mirrorKey(applied!)]);
    await deaf.once();
    await pool.query(`UPDATE outbox SET next_attempt_at = now()`);
    // Both are now indistinguishable INFLIGHT-turned-UNKNOWN rows.
    await pool.query(`UPDATE outbox SET state='UNKNOWN', attempts=1, lease_owner=NULL, lease_expires_at=NULL`);

    const relay = mirrorRelay(pool, realSink);
    expect(await relay.reconcile()).toEqual({ examined: 2, confirmed: 1, absent: 1, unresolved: 0 });
    expect(await row(absent!)).toMatchObject({ state: 'PENDING', resolution: 'absent_at_consumer_after_crash' });
    expect(await row(applied!)).toMatchObject({ state: 'DELIVERED', resolution: 'confirmed_by_consumer_after_crash' });
    // The page id the crashed attempt never got to record is recovered from the
    // consumer rather than guessed or refiled.
    expect(await pageId(applied!)).toBe((await sinkPool.query<{ page_id: string }>('SELECT page_id FROM ledger_pages WHERE job_id=$1', [applied])).rows[0]!.page_id);

    await relay.once();
    expect(await pages(absent!)).toBe(1);
    expect(await pages(applied!)).toBe(1);
  });

  // Reconciliation is allowed to fail. It is not allowed to guess.
  it('leaves a row UNKNOWN when the consumer cannot be asked', async () => {
    const [jobId] = await seed(1);
    await claimJobsForMirror(pool, 10, 'Found');
    await pool.query(`UPDATE outbox SET state='UNKNOWN', attempts=1`);
    const relay = new Relay({
      pool, sink: { deliver: () => Promise.reject(new Error('unused')), lookup: () => Promise.reject(new NoLookupError()) }
    });
    expect(await relay.reconcile()).toEqual({ examined: 1, confirmed: 0, absent: 0, unresolved: 1 });
    expect((await row(jobId!)).state).toBe('UNKNOWN');
    expect((await pool.query('SELECT last_error FROM outbox')).rows[0].last_error).toMatch(/unresolved/);
    expect(await pages(jobId!)).toBe(0);
  });

  it('records the page id and the message completion in one transaction', async () => {
    const [jobId] = await seed(1);
    await claimJobsForMirror(pool, 10, 'Found');
    await mirrorRelay(pool, realSink).once();
    const filed = (await sinkPool.query<{ page_id: string }>('SELECT page_id FROM ledger_pages WHERE job_id=$1', [jobId])).rows[0]!;
    expect(await pageId(jobId!)).toBe(filed.page_id);
    expect((await row(jobId!)).state).toBe('DELIVERED');
  });

  // The key is a function of which role, not of the attempt. If it ever becomes
  // attempt-dependent, every retry looks like a new page.
  it('keys a message by the role and nothing else', () => {
    expect(mirrorKey('abc')).toBe(mirrorKey('abc'));
    expect(mirrorKey('abc')).not.toBe(mirrorKey('abd'));
  });
});
