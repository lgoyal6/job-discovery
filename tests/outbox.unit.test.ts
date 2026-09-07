import { describe, expect, it } from 'vitest';
import { DeliveryRefusedError, Relay } from '../src/outbox.js';

describe('outbox delivery classification', () => {
  it('leaves a response-loss outcome UNKNOWN instead of retrying the effect', async () => {
    let state = 'PENDING';
    let attempts = 0;
    let effects = 0;
    const pool = {
      async query(sql: string) {
        if (sql.includes("WHERE state='INFLIGHT' AND lease_expires_at")) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("SET state='INFLIGHT'")) {
          if (state !== 'PENDING') return { rowCount: 0, rows: [] };
          state = 'INFLIGHT';
          attempts += 1;
          return {
            rows: [{ id: '1', idempotency_key: 'mirror:probe', topic: 'notion.ledger.page', payload: { jobId: 'probe' }, attempts }]
          };
        }
        if (sql.includes("SET state='UNKNOWN'")) {
          state = 'UNKNOWN';
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("ELSE 'PENDING'")) {
          state = 'PENDING';
          return { rowCount: 1, rows: [{ state }] };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }
    };
    const sink = {
      async deliver() {
        effects += 1;
        throw new Error('response lost after downstream committed');
      },
      async lookup() { throw new Error('unused'); }
    };

    const first = await new Relay({ pool: pool as never, sink }).once();
    const second = await new Relay({ pool: pool as never, sink }).once();

    expect(first.unknown).toBe(1);
    expect(second.claimed).toBe(0);
    expect({ effects, attempts, state }).toEqual({ effects: 1, attempts: 1, state: 'UNKNOWN' });
  });

  it('retries only a sink refusal that guarantees no effect occurred', async () => {
    let state = 'PENDING';
    let attempts = 0;
    const pool = {
      async query(sql: string) {
        if (sql.includes("WHERE state='INFLIGHT' AND lease_expires_at")) return { rowCount: 0, rows: [] };
        if (sql.includes("SET state='INFLIGHT'")) {
          if (state !== 'PENDING') return { rowCount: 0, rows: [] };
          state = 'INFLIGHT';
          attempts += 1;
          return { rows: [{ id: '1', idempotency_key: 'mirror:probe', topic: 'notion.ledger.page', payload: {}, attempts }] };
        }
        if (sql.includes("ELSE 'PENDING'")) {
          state = 'PENDING';
          return { rowCount: 1, rows: [{ state }] };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }
    };
    const sink = {
      async deliver() { throw new DeliveryRefusedError('request rejected before application'); },
      async lookup() { throw new Error('unused'); }
    };

    const first = await new Relay({ pool: pool as never, sink }).once();
    const second = await new Relay({ pool: pool as never, sink }).once();

    expect(first.retrying).toBe(1);
    expect(second.retrying).toBe(1);
    expect({ attempts, state }).toEqual({ attempts: 2, state: 'PENDING' });
  });
});
