import { createServer, type Server } from 'node:http';
import pg from 'pg';
import { newReceipt } from './outbox.js';

/**
 * The consumer: a stand-in for the Notion ledger that keeps an inbox.
 *
 * It lives in its OWN database so that "the effect and the inbox row commit
 * together" is a claim about one transaction in one database, and not a trick
 * played across two. It is the party that decides how many times a page gets
 * filed, which is the whole point: the relay is at-least-once and cannot be
 * anything else.
 *
 * Real Notion is not this. It has no idempotency key and will file a second
 * page for the same role without complaint. What that costs is stated on
 * NotionLedgerSink.lookup in mirror.ts: a delivery whose process died mid-call
 * cannot be settled from here, so the message stays UNKNOWN until somebody
 * looks. The mechanism is proved against a consumer that does keep an inbox,
 * which is what this is.
 */

export const SINK_SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox (
  idempotency_key text PRIMARY KEY,
  topic           text NOT NULL,
  payload         jsonb NOT NULL,
  receipt         text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  -- Every redelivery bumps this. It measures how much duplicate traffic the
  -- at-least-once relay actually produced, so a test cannot pass by never
  -- redelivering anything.
  deliveries      integer NOT NULL DEFAULT 1
);

-- The effect. "Landed once" is counted from exactly this table, and it
-- deliberately carries NO unique constraint on idempotency_key: with one,
-- Postgres would be doing the deduplication and the inbox would be decoration.
CREATE TABLE IF NOT EXISTS ledger_pages (
  page_id         text PRIMARY KEY,
  idempotency_key text NOT NULL REFERENCES inbox(idempotency_key),
  job_id          text NOT NULL,
  company         text NOT NULL,
  title           text NOT NULL,
  url             text,
  status          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_pages_job_idx ON ledger_pages(job_id);
`;

export interface LedgerPagePayload {
  jobId: string; company: string; title: string; url?: string | null; status: string;
}

export class LedgerSink {
  /**
   * `dedupe: false` is the negative control. With the inbox off this is an
   * ordinary at-least-once consumer and a redelivered message files a second
   * page, which is what the crash record shows before turning it on. Nothing in
   * the pipeline ever constructs one this way.
   */
  constructor(private readonly pool: pg.Pool, private readonly dedupe = true) {}

  async migrate(): Promise<void> { await this.pool.query(SINK_SCHEMA); }

  /**
   * Files a ledger page, at most once per idempotency key.
   *
   * The inbox row and the page are written in ONE transaction of THIS database.
   * That is the entire dedup guarantee: if the page is visible then so is the
   * key that suppresses the next delivery of it. Doing a "have I seen this?"
   * SELECT and then an INSERT would leave a window where two concurrent
   * deliveries both see nothing and both file.
   */
  async apply(key: string, topic: string, payload: LedgerPagePayload): Promise<{ receipt: string; duplicate: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const receipt = newReceipt();
      if (this.dedupe) {
        const inserted = await client.query(
          `INSERT INTO inbox(idempotency_key, topic, payload, receipt) VALUES($1,$2,$3,$4)
           ON CONFLICT (idempotency_key) DO NOTHING RETURNING receipt`,
          [key, topic, JSON.stringify(payload), receipt]);
        if (!inserted.rowCount) {
          // The key is here, so the page it stands for was written by the same
          // commit. Hand back the original page id and file nothing.
          const prior = await client.query<{ receipt: string }>(
            'UPDATE inbox SET deliveries = deliveries + 1 WHERE idempotency_key=$1 RETURNING receipt', [key]);
          const existing = prior.rows[0];
          // The INSERT reported a conflict, so the row is there. If it is not,
          // something outside this transaction deleted it and the caller must
          // not be told a page was filed.
          if (!existing) throw new Error(`inbox row for ${key} vanished mid-transaction`);
          await client.query('COMMIT');
          return { receipt: existing.receipt, duplicate: true };
        }
      } else {
        await client.query(
          `INSERT INTO inbox(idempotency_key, topic, payload, receipt) VALUES($1,$2,$3,$4)
           ON CONFLICT (idempotency_key) DO UPDATE SET deliveries = inbox.deliveries + 1`,
          [key, topic, JSON.stringify(payload), receipt]);
      }
      await client.query(
        `INSERT INTO ledger_pages(page_id, idempotency_key, job_id, company, title, url, status)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [receipt, key, payload.jobId, payload.company, payload.title, payload.url ?? null, payload.status]);
      await client.query('COMMIT');
      return { receipt, duplicate: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  /** The reconciliation question: do you have this key? */
  async receipt(key: string): Promise<string | null> {
    const rows = await this.pool.query<{ receipt: string }>('SELECT receipt FROM inbox WHERE idempotency_key=$1', [key]);
    return rows.rows[0]?.receipt ?? null;
  }

  listen(port: number, host = '127.0.0.1'): Promise<Server> {
    const server = createServer((request, response) => {
      const send = (code: number, body: unknown): void => {
        response.writeHead(code, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname.startsWith('/v1/pages/')) {
        const key = decodeURIComponent(url.pathname.slice('/v1/pages/'.length));
        this.receipt(key)
          .then(receipt => (receipt ? send(200, { receipt, duplicate: true }) : send(404, { error: 'not found' })))
          .catch((error: unknown) => send(500, { error: String(error) }));
        return;
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/pages') { send(404, { error: 'not found' }); return; }
      const key = request.headers['idempotency-key'];
      const topic = request.headers['x-outbox-topic'];
      if (typeof key !== 'string' || typeof topic !== 'string') { send(400, { error: 'Idempotency-Key and X-Outbox-Topic are required' }); return; }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let payload: LedgerPagePayload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as LedgerPagePayload; }
        catch (error) { send(400, { error: String(error) }); return; }
        this.apply(key, topic, payload)
          .then(result => send(200, result))
          .catch((error: unknown) => send(500, { error: error instanceof Error ? error.message : String(error) }));
      });
    });
    return new Promise(resolve => server.listen(port, host, () => resolve(server)));
  }
}

/** The producer's view of a remote consumer. */
export class HttpLedgerSink {
  /** `lookupDisabled` models a downstream that cannot be asked, such as Notion. */
  constructor(private readonly baseUrl: string, private readonly lookupDisabled = false) {}

  async deliver(message: { idempotencyKey: string; topic: string; payload: Record<string, unknown> }): Promise<{ receipt: string; duplicate: boolean }> {
    const response = await fetch(`${this.baseUrl}/v1/pages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': message.idempotencyKey, 'x-outbox-topic': message.topic },
      body: JSON.stringify(message.payload)
    });
    if (!response.ok) throw new Error(`sink returned ${response.status}`);
    return await response.json() as { receipt: string; duplicate: boolean };
  }

  async lookup(key: string): Promise<{ receipt: string } | null> {
    if (this.lookupDisabled) throw new (await import('./outbox.js')).NoLookupError();
    const response = await fetch(`${this.baseUrl}/v1/pages/${encodeURIComponent(key)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`sink lookup returned ${response.status}`);
    return await response.json() as { receipt: string };
  }
}
