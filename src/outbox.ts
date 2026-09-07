import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * A side effect and the state change it belongs to, carried across a crash.
 *
 * The mirror used to write a Notion page and then record its id, which meant a
 * run killed between the two produced a page nobody here knew about and a
 * duplicate on the next run. Writing the message into the same transaction as
 * the claim removes the ordering entirely: after the commit, the intent to
 * write the page is exactly as durable as the claim that a page is owed.
 *
 * This does not make delivery happen once. Delivery is retried, so the
 * downstream sees a message more than once; landing once is the consumer's job
 * and the inbox in outbox-sink.ts is where it is done. The guarantee is
 * at-least-once delivery carrying an idempotency key derived from the state
 * change, and it assumes a consumer that keeps an inbox keyed on it.
 */

export type OutboxState = 'PENDING' | 'INFLIGHT' | 'UNKNOWN' | 'DELIVERED' | 'FAILED';

export const TOPIC_MIRROR_PAGE = 'notion.ledger.page';

export interface OutboxMessage {
  id: number;
  idempotencyKey: string;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** The key is a function of WHICH job, never of the attempt or the clock. */
export function mirrorKey(jobId: string): string {
  return `mirror:${jobId}`;
}

/**
 * Writes a message inside the caller's transaction.
 *
 * The parameter is a PoolClient and not a Pool on purpose: a Pool would hand
 * out some other connection, the insert would land outside the caller's
 * transaction, and this would be the dual write it exists to remove. A repeat
 * of the same key is dropped, so a producer that retries does not queue the
 * effect twice.
 */
export async function enqueue(
  client: pg.PoolClient, key: string, topic: string, payload: unknown
): Promise<void> {
  await client.query(
    `INSERT INTO outbox(idempotency_key, topic, payload) VALUES($1, $2, $3)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [key, topic, JSON.stringify(payload)]
  );
}

/** Where a process may be killed. Production installs no hook. */
export type CrashPoint = 'after_commit' | 'before_send' | 'after_send';
export type Crasher = (point: CrashPoint) => void;

const fire = (crash: Crasher | undefined, point: CrashPoint): void => { if (crash) crash(point); };

export interface DeliveryResult { receipt: string; duplicate: boolean }

/**
 * The downstream. `lookup` is what makes an ambiguous outcome resolvable: after
 * a crash the only party that knows whether the effect landed is the one that
 * would have applied it, so reconciliation asks it rather than guessing.
 */
export interface Sink {
  deliver(message: OutboxMessage): Promise<DeliveryResult>;
  lookup(idempotencyKey: string): Promise<{ receipt: string } | null>;
}

/** Thrown by a sink that offers no way to ask whether it holds a key. */
export class NoLookupError extends Error {
  constructor() { super('the downstream cannot be asked whether it holds a key'); this.name = 'NoLookupError'; }
}

/** A sink may use this only when it knows the downstream effect did not occur. */
export class DeliveryRefusedError extends Error {
  constructor(message: string) { super(message); this.name = 'DeliveryRefusedError'; }
}

export interface PassResult { expired: number; claimed: number; delivered: number; retrying: number; failed: number; unknown: number }
export interface ReconcileResult { examined: number; confirmed: number; absent: number; unresolved: number }

export interface RelayOptions {
  pool: pg.Pool;
  sink: Sink;
  owner?: string;
  /** How long a claimed row is left alone before its owner is presumed dead. */
  leaseMs?: number;
  batch?: number;
  /**
   * Gap between deliveries. Notion answers 429 past about three writes a
   * second, and a relay that races the rate limiter just converts a paced
   * success into a retried failure.
   */
  pauseMs?: number;
  crash?: Crasher;
  /**
   * Applies the consumer's answer to the producer's own tables, in the SAME
   * transaction that marks the message delivered. For the mirror this is the
   * write of notion_page_id: recording the page id and recording that the
   * message is done are one commit, so there is no second window to crash in.
   */
  onDelivered?: (client: pg.PoolClient, message: OutboxMessage, receipt: string) => Promise<void>;
}

export class Relay {
  private readonly pool: pg.Pool;
  private readonly sink: Sink;
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly batch: number;
  private readonly pauseMs: number;
  private readonly crash?: Crasher;
  private readonly onDelivered?: RelayOptions['onDelivered'];

  constructor(options: RelayOptions) {
    this.pool = options.pool;
    this.sink = options.sink;
    this.owner = options.owner ?? `pid-${process.pid}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.batch = options.batch ?? 32;
    this.pauseMs = options.pauseMs ?? 0;
    this.crash = options.crash;
    this.onDelivered = options.onDelivered;
  }

  /**
   * Moves INFLIGHT rows whose lease has run out to UNKNOWN.
   *
   * Deliberately not back to PENDING. PENDING asserts the consumer did not
   * receive the message, and this database has no way to know that; UNKNOWN is
   * a statement about our own ignorance and is always true.
   */
  async expireLeases(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE outbox SET state='UNKNOWN', lease_owner=NULL, lease_expires_at=NULL,
              last_error='attempting process did not report back before its lease expired',
              updated_at=now()
        WHERE state='INFLIGHT' AND lease_expires_at < now()`);
    return result.rowCount ?? 0;
  }

  /**
   * Records the attempt and commits it BEFORE anything is sent. That commit is
   * the durable attempt state: it is the only thing that survives the kill, and
   * it is the reason a dead attempt is recognisable as one.
   */
  private async claim(): Promise<OutboxMessage[]> {
    const result = await this.pool.query<{ id: string; idempotency_key: string; topic: string; payload: Record<string, unknown>; attempts: number }>(
      `UPDATE outbox SET state='INFLIGHT', attempts=attempts+1, last_attempt_at=now(),
              lease_owner=$1, lease_expires_at=now() + make_interval(secs => $2::double precision),
              updated_at=now()
        WHERE id IN (
          SELECT id FROM outbox WHERE state='PENDING' AND next_attempt_at <= now()
           ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $3
        )
        RETURNING id, idempotency_key, topic, payload, attempts`,
      [this.owner, this.leaseMs / 1000, this.batch]);
    return result.rows.map(row => ({
      id: Number(row.id), idempotencyKey: row.idempotency_key, topic: row.topic,
      payload: row.payload, attempts: row.attempts
    }));
  }

  async once(): Promise<PassResult> {
    const result: PassResult = { expired: await this.expireLeases(), claimed: 0, delivered: 0, retrying: 0, failed: 0, unknown: 0 };
    const messages = await this.claim();
    result.claimed = messages.length;

    let first = true;
    for (const message of messages) {
      if (!first && this.pauseMs > 0) await new Promise(resolve => setTimeout(resolve, this.pauseMs));
      first = false;
      // The attempt is committed. A process killed on the next line leaves a
      // row saying "attempt N began" and nothing more, which is exactly as
      // much as is true.
      fire(this.crash, 'before_send');
      let receipt: string;
      try {
        receipt = (await this.sink.deliver(message)).receipt;
      } catch (error) {
        if (error instanceof DeliveryRefusedError) {
          if (await this.recordFailure(message, error)) result.failed += 1; else result.retrying += 1;
        } else {
          await this.recordUnknown(message, error);
          result.unknown += 1;
        }
        continue;
      }
      // The consumer has the effect. Nothing here knows it yet.
      fire(this.crash, 'after_send');
      await this.recordDelivered(message, receipt, 'delivered');
      result.delivered += 1;
    }
    return result;
  }

  /**
   * One transaction: the producer's own state change (the page id) and the
   * message's completion. Splitting them would put the dual write back, one
   * layer down.
   */
  private async recordDelivered(message: OutboxMessage, receipt: string, resolution: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (this.onDelivered) await this.onDelivered(client, message, receipt);
      await client.query(
        `UPDATE outbox SET state='DELIVERED', receipt=$2, resolution=$3, delivered_at=now(),
                lease_owner=NULL, lease_expires_at=NULL, last_error=NULL, updated_at=now()
          WHERE id=$1`, [message.id, receipt, resolution]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  /**
   * A refused delivery is the one case where the producer does know the effect
   * did not land, so PENDING is a true statement here in a way it is not after
   * a crash.
   */
  private async recordFailure(message: OutboxMessage, cause: unknown): Promise<boolean> {
    const backoffSeconds = Math.min(2 ** Math.min(message.attempts, 6), 60);
    const result = await this.pool.query<{ state: OutboxState }>(
      `UPDATE outbox
          SET state = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'PENDING' END,
              next_attempt_at = now() + make_interval(secs => $2::double precision),
              last_error = $3, lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
        WHERE id = $1 RETURNING state`,
      [message.id, backoffSeconds, cause instanceof Error ? cause.message : String(cause)]);
    return result.rows[0]?.state === 'FAILED';
  }

  /**
   * A thrown transport result is ambiguous unless the sink explicitly proves it
   * refused the request before applying the effect. Keep it visible for
   * reconciliation instead of creating a duplicate by retrying blindly.
   */
  private async recordUnknown(message: OutboxMessage, cause: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE outbox SET state='UNKNOWN', lease_owner=NULL, lease_expires_at=NULL,
              last_error=$2, updated_at=now()
        WHERE id=$1`,
      [message.id, `delivery outcome unknown: ${cause instanceof Error ? cause.message : String(cause)}`]
    );
  }

  /**
   * Settles UNKNOWN rows by asking the consumer whether it holds the key.
   *
   * Neither answer is assumed. A consumer that cannot be reached leaves the row
   * exactly where it is, and it stays visible as unresolved for as long as that
   * is true. The alternatives are a silently lost page and a silently
   * duplicated one; the crash record shows both happening.
   */
  async reconcile(): Promise<ReconcileResult> {
    const result: ReconcileResult = { examined: 0, confirmed: 0, absent: 0, unresolved: 0 };
    const rows = await this.pool.query<{ id: string; idempotency_key: string; topic: string; payload: Record<string, unknown>; attempts: number }>(
      `SELECT id, idempotency_key, topic, payload, attempts FROM outbox WHERE state='UNKNOWN' ORDER BY id`);

    for (const row of rows.rows) {
      result.examined += 1;
      const message: OutboxMessage = {
        id: Number(row.id), idempotencyKey: row.idempotency_key, topic: row.topic,
        payload: row.payload, attempts: row.attempts
      };
      let held: { receipt: string } | null;
      try {
        held = await this.sink.lookup(message.idempotencyKey);
      } catch (error) {
        result.unresolved += 1;
        await this.pool.query('UPDATE outbox SET last_error=$2, updated_at=now() WHERE id=$1',
          [message.id, `unresolved: ${error instanceof Error ? error.message : String(error)}`]);
        continue;
      }
      if (held) {
        await this.recordDelivered(message, held.receipt, 'confirmed_by_consumer_after_crash');
        result.confirmed += 1;
        continue;
      }
      await this.pool.query(
        `UPDATE outbox SET state='PENDING', next_attempt_at=now(),
                resolution='absent_at_consumer_after_crash', last_error=NULL, updated_at=now()
          WHERE id=$1`, [message.id]);
      result.absent += 1;
    }
    return result;
  }
}

export async function outboxCounts(pool: pg.Pool): Promise<Record<string, number>> {
  const rows = await pool.query<{ state: string; count: string }>('SELECT state, count(*) FROM outbox GROUP BY state');
  return Object.fromEntries(rows.rows.map(row => [row.state, Number(row.count)]));
}

export const newReceipt = (): string => `page_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
