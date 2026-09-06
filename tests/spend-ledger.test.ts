/**
 * The paid-source spend ledger.
 *
 * Every number here is a fixture. No test in this file reaches the network, and
 * none of them touches a real Apify account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySpendStore, SpendLedger, microsToUsd, usdToMicros } from '../src/spend.js';

const AUGUST = '2026-08';

function ledgerAt(budgetUsd = 5, at = '2026-08-14T12:00:00.000Z'): { ledger: SpendLedger; store: InMemorySpendStore; tick: (ms: number) => void } {
  const store = new InMemorySpendStore();
  let now = new Date(at).getTime();
  const ledger = new SpendLedger({ store, monthlyBudgetUsd: budgetUsd, clock: () => new Date(now) });
  return { ledger, store, tick: (ms: number) => { now += ms; } };
}

describe('money arithmetic', () => {
  it('never routes a charge through a binary float', () => {
    // 0.1 + 0.2 is 0.30000000000000004. Three ten-cent charges must be $0.30.
    const total = usdToMicros(0.1) + usdToMicros(0.1) + usdToMicros(0.1);
    expect(microsToUsd(total)).toBe(0.3);
    expect(usdToMicros(0.49)).toBe(490_000);
  });

  it('refuses a charge it cannot represent rather than rounding it to nothing', () => {
    expect(() => usdToMicros(Number.NaN)).toThrow(/not a number/i);
    expect(() => usdToMicros(-1)).toThrow(/negative/i);
  });
});

describe('a budget enforced before the money is spent', () => {
  it('refuses a run the month cannot pay for, and names the shortfall', async () => {
    const { ledger } = ledgerAt(1);
    const first = await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });
    expect(first.ok).toBe(true);

    const second = await ledger.reserve({ runKey: 'run-2', source: 'apify:monster', maxChargeUsd: 0.5 });
    expect(second.ok).toBe(true);

    const third = await ledger.reserve({ runKey: 'run-3', source: 'apify:monster', maxChargeUsd: 0.5 });
    expect(third.ok).toBe(false);
    if (third.ok) throw new Error('unreachable');
    expect(third.shortfallUsd).toBe(0.5);
    expect(third.reason).toContain('$0.50');
    expect(third.reason).toContain('$1.00');
  });

  it('counts a run still in flight against the budget, not just finished ones', async () => {
    // The failure this prevents: three runs started back to back all see an
    // empty spent column and all pass the check, then all three charge.
    const { ledger } = ledgerAt(1);
    await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });
    const balance = await ledger.balance(AUGUST);
    expect(balance.heldUsd).toBe(0.5);
    expect(balance.availableUsd).toBe(0.5);
  });

  it('gives back the difference when a run cost less than it reserved', async () => {
    const { ledger } = ledgerAt(5);
    await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });
    await ledger.settle({ runKey: 'run-1', actualChargeUsd: 0.12 });

    const balance = await ledger.balance(AUGUST);
    expect(balance.settledUsd).toBe(0.12);
    expect(balance.heldUsd).toBe(0);
    expect(balance.availableUsd).toBe(4.88);
  });

  it('records the whole charge when a provider bills past the cap it was given', async () => {
    const { ledger } = ledgerAt(5);
    await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });
    await ledger.settle({ runKey: 'run-1', actualChargeUsd: 0.9 });

    const balance = await ledger.balance(AUGUST);
    expect(balance.settledUsd).toBe(0.9);
    expect(balance.heldUsd).toBe(0);
  });
});

describe('a retry must not charge twice', () => {
  it('reserving the same run key again does not commit the budget twice', async () => {
    const { ledger } = ledgerAt(5);
    const first = await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });
    const again = await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });

    expect(first.ok && again.ok).toBe(true);
    expect((await ledger.balance(AUGUST)).heldUsd).toBe(0.5);
  });

  it('settling the same run key twice charges once', async () => {
    const { ledger } = ledgerAt(5);
    await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });
    await ledger.settle({ runKey: 'run-1', actualChargeUsd: 0.4 });
    await ledger.settle({ runKey: 'run-1', actualChargeUsd: 0.4 });

    expect((await ledger.balance(AUGUST)).settledUsd).toBe(0.4);
  });

  it('abandoning a run that already settled leaves the settlement alone', async () => {
    const { ledger } = ledgerAt(5);
    await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });
    await ledger.settle({ runKey: 'run-1', actualChargeUsd: 0.4 });
    await ledger.abandon({ runKey: 'run-1', reason: 'late timeout' });

    const balance = await ledger.balance(AUGUST);
    expect(balance.settledUsd).toBe(0.4);
    expect(balance.abandonedUsd).toBe(0);
  });
});

describe('a client that gives up mid-run', () => {
  it('charges the reservation rather than dropping it, because the actor keeps billing', async () => {
    // run-sync does not cancel the actor when the socket dies. It stays up on
    // the provider's side and bills to its own cap, so the only number we can
    // defend is the cap we authorised.
    const { ledger } = ledgerAt(5);
    await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });
    await ledger.abandon({ runKey: 'run-1', reason: 'socket timed out after 270s' });

    const balance = await ledger.balance(AUGUST);
    expect(balance.abandonedUsd).toBe(0.5);
    expect(balance.settledUsd).toBe(0);
    expect(balance.heldUsd).toBe(0);
    expect(balance.committedUsd).toBe(0.5);
  });

  it('keeps abandoned money separate from money that bought something', async () => {
    const { ledger } = ledgerAt(5);
    await ledger.reserve({ runKey: 'ok', source: 'apify:monster', maxChargeUsd: 0.5 });
    await ledger.settle({ runKey: 'ok', actualChargeUsd: 0.3 });
    await ledger.reserve({ runKey: 'lost', source: 'apify:monster', maxChargeUsd: 0.5 });
    await ledger.abandon({ runKey: 'lost', reason: 'socket timed out' });

    const balance = await ledger.balance(AUGUST);
    expect(balance.settledUsd).toBe(0.3);
    expect(balance.abandonedUsd).toBe(0.5);
    expect(balance.committedUsd).toBe(0.8);
  });
});

describe('a provider that never says what it charged', () => {
  it('settles at the authorised cap and marks the number an upper bound', async () => {
    // run-sync-get-dataset-items answers with the dataset and nothing else: no
    // run id, no usage. The work completed, so this is spend that bought
    // something; the amount is a ceiling, not a measurement, and saying which
    // is the difference between a ledger and a guess.
    const { ledger } = ledgerAt(5);
    await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });
    await ledger.settle({ runKey: 'run-1' });

    const balance = await ledger.balance(AUGUST);
    expect(balance.settledUsd).toBe(0.5);
    expect(balance.measuredUsd).toBe(0);
    expect(balance.upperBoundUsd).toBe(0.5);

    const entry = (await ledger.entries(AUGUST)).find(e => e.kind === 'SETTLE');
    expect(entry?.measured).toBe(false);
  });

  it('prefers a real number when the provider does give one', async () => {
    const { ledger } = ledgerAt(5);
    await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });
    await ledger.settle({ runKey: 'run-1', actualChargeUsd: 0.49 });

    const balance = await ledger.balance(AUGUST);
    expect(balance.measuredUsd).toBe(0.49);
    expect(balance.upperBoundUsd).toBe(0);
  });
});

describe('a crash between reserving and settling', () => {
  it('leaves the reservation outstanding rather than losing it', async () => {
    const { ledger, store } = ledgerAt(5);
    await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });

    // The process dies here. A new one comes up over the same rows.
    const restarted = new SpendLedger({ store, monthlyBudgetUsd: 5, clock: () => new Date('2026-08-14T12:30:00.000Z') });
    const outstanding = await restarted.outstanding(AUGUST);
    expect(outstanding.map(entry => entry.runKey)).toEqual(['run-1']);
    expect((await restarted.balance(AUGUST)).heldUsd).toBe(0.5);
  });

  it('turns a reservation that outlived its run into abandoned spend, not free money', async () => {
    const { ledger, store, tick } = ledgerAt(5);
    await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });
    tick(60 * 60 * 1000);

    const restarted = new SpendLedger({ store, monthlyBudgetUsd: 5, clock: () => new Date('2026-08-14T13:00:00.000Z') });
    const recovered = await restarted.recoverOutstanding(AUGUST, 30 * 60 * 1000);

    expect(recovered).toBe(1);
    const balance = await restarted.balance(AUGUST);
    expect(balance.abandonedUsd).toBe(0.5);
    expect(balance.heldUsd).toBe(0);
    expect(await restarted.outstanding(AUGUST)).toEqual([]);
  });

  it('leaves a run that is still inside its window alone', async () => {
    const { ledger, store } = ledgerAt(5);
    await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });

    const restarted = new SpendLedger({ store, monthlyBudgetUsd: 5, clock: () => new Date('2026-08-14T12:05:00.000Z') });
    expect(await restarted.recoverOutstanding(AUGUST, 30 * 60 * 1000)).toBe(0);
    expect((await restarted.balance(AUGUST)).heldUsd).toBe(0.5);
  });

  it('recovering twice does not charge the same lost run twice', async () => {
    const { ledger, store } = ledgerAt(5);
    await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });

    const restarted = new SpendLedger({ store, monthlyBudgetUsd: 5, clock: () => new Date('2026-08-14T13:00:00.000Z') });
    await restarted.recoverOutstanding(AUGUST, 30 * 60 * 1000);
    await restarted.recoverOutstanding(AUGUST, 30 * 60 * 1000);

    expect((await restarted.balance(AUGUST)).abandonedUsd).toBe(0.5);
  });
});

describe('billing periods', () => {
  it('keeps each month to its own budget', async () => {
    const store = new InMemorySpendStore();
    const august = new SpendLedger({ store, monthlyBudgetUsd: 1, clock: () => new Date('2026-08-31T23:00:00.000Z') });
    await august.reserve({ runKey: 'aug', source: 'apify:monster', maxChargeUsd: 0.5 });
    await august.settle({ runKey: 'aug', actualChargeUsd: 0.5 });

    const september = new SpendLedger({ store, monthlyBudgetUsd: 1, clock: () => new Date('2026-09-01T01:00:00.000Z') });
    expect((await september.balance('2026-09')).availableUsd).toBe(1);
    expect((await september.balance(AUGUST)).settledUsd).toBe(0.5);
  });
});

describe('the ledger is append only', () => {
  it('corrects a run by writing another row, never by editing one', async () => {
    const { ledger } = ledgerAt(5);
    await ledger.reserve({ runKey: 'run-1', source: 'apify:monster', maxChargeUsd: 0.5 });
    await ledger.settle({ runKey: 'run-1', actualChargeUsd: 0.2 });

    const entries = await ledger.entries(AUGUST);
    expect(entries.map(entry => entry.kind)).toEqual(['RESERVE', 'SETTLE', 'RELEASE']);
    expect(Object.isFrozen(entries[0])).toBe(true);
  });
});

describe('what the pipeline reports', () => {
  it('describes a month in one line an operator can act on', async () => {
    const { ledger } = ledgerAt(5);
    await ledger.reserve({ runKey: 'a', source: 'apify:monster', maxChargeUsd: 0.5 });
    await ledger.settle({ runKey: 'a', actualChargeUsd: 0.49 });
    await ledger.reserve({ runKey: 'b', source: 'apify:monster', maxChargeUsd: 0.5 });
    await ledger.abandon({ runKey: 'b', reason: 'socket timed out' });

    const line = await ledger.describe(AUGUST);
    expect(line).toContain('$0.49 spent');
    expect(line).toContain('$0.50 abandoned');
    expect(line).toContain('$4.01 left');
  });
});

beforeEach(() => {
  // Nothing shared between tests: every ledger above builds its own store.
});

describe('the paid source spends through the ledger', () => {
  const withApifyEnv = (): void => {
    process.env.APIFY_TOKEN = 'test-apify-token';
    process.env.APIFY_ENABLED = 'true';
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const key of ['APIFY_TOKEN', 'APIFY_ENABLED']) delete process.env[key];
    vi.resetModules();
  });

  it('records what a successful run cost instead of the literal zero', async () => {
    withApifyEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })));
    const { ApifySource } = await import('../src/sources/apify.js');
    const { ledger } = ledgerAt(5, new Date().toISOString());

    const result = await new ApifySource('monster', 'owner/monster', 150, [], ledger).fetch();
    expect(result.status).toBe('SUCCESS');
    expect(result.costUnits).toBe(0.5);

    const balance = await ledger.balance();
    expect(balance.settledUsd).toBe(0.5);
    expect(balance.upperBoundUsd).toBe(0.5);
    expect(balance.heldUsd).toBe(0);
  });

  it('does not open a socket once the month is spent', async () => {
    withApifyEnv();
    const mockedFetch = vi.fn().mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', mockedFetch);
    const { ApifySource } = await import('../src/sources/apify.js');
    // A budget with room for one run, and two runs asked for.
    const { ledger } = ledgerAt(0.5, new Date().toISOString());

    const first = await new ApifySource('monster', 'owner/monster', 150, [], ledger).fetch();
    const second = await new ApifySource('monster', 'owner/monster', 150, [], ledger).fetch();

    expect(first.status).toBe('SUCCESS');
    expect(second.status).toBe('SKIPPED');
    expect(second.error).toContain('refused');
    expect(second.metrics?.refusedOnBudget).toBe(true);
    // The refusal happens before the call, so the second run never reached Apify.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('charges a run the client gave up on rather than recording it as free', async () => {
    withApifyEnv();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })));
    const { ApifySource } = await import('../src/sources/apify.js');
    const { ledger } = ledgerAt(5, new Date().toISOString());

    const result = await new ApifySource('monster', 'owner/monster', 150, [], ledger).fetch();
    expect(result.status).toBe('FAILED');

    const balance = await ledger.balance();
    expect(balance.abandonedUsd).toBe(0.5);
    expect(balance.settledUsd).toBe(0);
    expect(balance.heldUsd).toBe(0);
  });

  it('leaves no reservation outstanding once a run has finished either way', async () => {
    withApifyEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })));
    const { ApifySource } = await import('../src/sources/apify.js');
    const { ledger } = ledgerAt(5, new Date().toISOString());

    await new ApifySource('monster', 'owner/monster', 150, [], ledger).fetch();
    expect(await ledger.outstanding()).toEqual([]);
  });
});
