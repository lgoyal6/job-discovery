/**
 * The spend ledger over a real PostgreSQL, because the properties that matter
 * are enforced by the database rather than by the application.
 *
 * Runs only when TEST_DATABASE_URL points at a throwaway database, the same gate
 * db.integration.test.ts uses. Nothing here touches real application rows: every
 * value is a fixture and the only table it reads is paid_source_spend.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const suite = enabled ? describe : describe.skip;

suite('paid source spend, durably', () => {
  it('survives a process that dies between authorising a run and hearing back', async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const { PgSpendStore, pool } = await import('../src/db.js');
    const { SpendLedger } = await import('../src/spend.js');

    const period = `t-${randomUUID().slice(0, 8)}`;
    const runKey = `run-${randomUUID()}`;
    const at = new Date('2026-08-14T12:00:00.000Z');
    const store = new PgSpendStore();
    const ledger = new SpendLedger({ store, monthlyBudgetUsd: 5, clock: () => at });

    // Reserve, written straight through to Postgres with the fixed period.
    await store.append({ runKey, source: 'apify:monster', kind: 'RESERVE', micros: 500_000, period, measured: true, note: 'authorised', at: at.toISOString() });
    expect((await ledger.balance(period)).heldUsd).toBe(0.5);

    // The process dies. A new ledger over the same rows still sees the money.
    const restarted = new SpendLedger({ store, monthlyBudgetUsd: 5, clock: () => new Date('2026-08-14T13:00:00.000Z') });
    expect((await restarted.outstanding(period)).map(entry => entry.runKey)).toEqual([runKey]);

    const recovered = await restarted.recoverOutstanding(period, 30 * 60 * 1000);
    expect(recovered).toBe(1);
    const balance = await restarted.balance(period);
    expect(balance.abandonedUsd).toBe(0.5);
    expect(balance.heldUsd).toBe(0);

    await pool.query('DELETE FROM paid_source_spend WHERE period=$1', [period]);
  });

  it('refuses a second charge for one run in the database, not just in the application', async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const { PgSpendStore, pool } = await import('../src/db.js');

    const period = `t-${randomUUID().slice(0, 8)}`;
    const runKey = `run-${randomUUID()}`;
    const store = new PgSpendStore();
    const row = { runKey, source: 'apify:monster', micros: 500_000, period, measured: true, note: '', at: new Date().toISOString() };

    // Two processes racing: neither can see the other's uncommitted work, so the
    // unique index is the only thing standing between one run and two charges.
    await store.append({ ...row, kind: 'RESERVE' });
    await store.append({ ...row, kind: 'RESERVE' });
    await store.append({ ...row, kind: 'SETTLE' });
    await store.append({ ...row, kind: 'ABANDONED' });

    const rows = await store.read(period);
    expect(rows.filter(entry => entry.kind === 'RESERVE')).toHaveLength(1);
    // SETTLE and ABANDONED share one partial index: a run closes exactly once.
    expect(rows.filter(entry => entry.kind === 'SETTLE' || entry.kind === 'ABANDONED')).toHaveLength(1);

    await pool.query('DELETE FROM paid_source_spend WHERE period=$1', [period]);
  });

  it('will not store a negative charge', async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const { PgSpendStore } = await import('../src/db.js');
    const store = new PgSpendStore();
    await expect(store.append({
      runKey: `run-${randomUUID()}`, source: 'apify:monster', kind: 'SETTLE', micros: -1,
      period: `t-${randomUUID().slice(0, 8)}`, measured: true, note: '', at: new Date().toISOString()
    })).rejects.toThrow();
  });

  afterAll(async () => {
    if (!enabled) return;
    const { pool } = await import('../src/db.js');
    await pool.end();
  });
});
