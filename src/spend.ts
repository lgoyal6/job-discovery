/**
 * What the paid sources cost, and whether the money bought anything.
 *
 * The pipeline had a `costUnits` field on every source run and wrote the
 * literal `0` into it from four places. Meanwhile one Monster actor charged
 * about $0.49 a run against a $5 monthly credit, `maxTotalChargeUsd` capped a
 * single run and nothing capped a month, and a run whose socket timed out was
 * recorded as `FAILED, costUnits: 0` while the actor stayed up on the
 * provider's side and kept billing. So the two questions an operator actually
 * has -- what did this month cost, and what did it buy -- had no answer.
 *
 * Four rules, and each one exists because the obvious alternative is wrong:
 *
 *   Reserve before the call, not after. A budget checked against money already
 *   spent lets three runs start together, all see an empty column, all pass,
 *   and all charge. The authorised ceiling is committed the moment the call is
 *   authorised.
 *
 *   Idempotent on a run key. Reserve, settle and abandon can all be reached
 *   twice by a retry or a re-run, and a ledger that adds on every attempt turns
 *   one leaked run into a month of phantom spend.
 *
 *   Abandoned is not settled. Both are real money. Only one of them bought
 *   something, and adding them up makes "what did we get for the money"
 *   unanswerable, which is the question the ledger exists to answer.
 *
 *   Integers, never floats. `0.1 + 0.2` is `0.30000000000000004`, and a ledger
 *   that drifts is a ledger nobody trusts. Everything is held in millionths of
 *   a dollar and converted at the edges.
 */

export type SpendKind = 'RESERVE' | 'SETTLE' | 'RELEASE' | 'ABANDONED';

export interface SpendEntry {
  /** One actor call. The idempotency key for every operation on that call. */
  runKey: string;
  source: string;
  kind: SpendKind;
  /** Millionths of a dollar. Integer, always. */
  micros: number;
  /** `YYYY-MM`, the month the budget resets on. */
  period: string;
  at: string;
  note: string;
  /**
   * Whether the amount is a measurement or the ceiling we authorised.
   *
   * `run-sync-get-dataset-items` answers with the dataset and nothing else: no
   * run id, no usage figure. The work completed and the money is gone, and the
   * only number we can defend is the cap. Saying which of the two a row is is
   * the difference between a ledger and a guess.
   */
  measured: boolean;
}

export interface SpendStore {
  read(period: string): Promise<SpendEntry[]>;
  append(entry: SpendEntry): Promise<void>;
}

const MICROS_PER_USD = 1_000_000;

export function usdToMicros(usd: number): number {
  if (typeof usd !== 'number' || Number.isNaN(usd)) throw new Error(`spend amount is not a number: ${String(usd)}`);
  if (!Number.isFinite(usd)) throw new Error(`spend amount is not finite: ${String(usd)}`);
  if (usd < 0) throw new Error(`spend amount is negative: ${usd}`);
  return Math.round(usd * MICROS_PER_USD);
}

export function microsToUsd(micros: number): number {
  // Two decimal places is what a dollar figure means. The rounding happens once,
  // on the way out, so nothing accumulates it.
  return Math.round((micros / MICROS_PER_USD) * 100) / 100;
}

function fmt(micros: number): string {
  return `$${microsToUsd(micros).toFixed(2)}`;
}

/** The `YYYY-MM` bucket a moment falls in, in UTC. */
export function billingPeriod(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

export class InMemorySpendStore implements SpendStore {
  private readonly rows: SpendEntry[] = [];

  async read(period: string): Promise<SpendEntry[]> {
    return this.rows.filter(row => row.period === period);
  }

  async append(entry: SpendEntry): Promise<void> {
    this.rows.push(entry);
  }

  /** Every row, any period. For assertions and for the durable store to seed from. */
  all(): readonly SpendEntry[] {
    return this.rows;
  }
}

export interface Reservation { ok: true; runKey: string; maxChargeUsd: number }
export interface Refusal { ok: false; reason: string; shortfallUsd: number }

export interface Balance {
  period: string;
  budgetUsd: number;
  /** Money that bought something, measured or capped. */
  settledUsd: number;
  /** The part of `settledUsd` a provider actually reported. */
  measuredUsd: number;
  /** The part of `settledUsd` that is the authorised ceiling, not a measurement. */
  upperBoundUsd: number;
  /** Money that bought nothing anybody can point at. */
  abandonedUsd: number;
  /** Authorised for a run that has not reported back yet. */
  heldUsd: number;
  committedUsd: number;
  availableUsd: number;
}

export interface SpendLedgerOptions {
  store: SpendStore;
  monthlyBudgetUsd: number;
  clock?: () => Date;
}

export class SpendLedger {
  private readonly store: SpendStore;
  private readonly budgetMicros: number;
  private readonly clock: () => Date;

  constructor({ store, monthlyBudgetUsd, clock = () => new Date() }: SpendLedgerOptions) {
    this.store = store;
    this.budgetMicros = usdToMicros(monthlyBudgetUsd);
    this.clock = clock;
  }

  period(): string {
    return billingPeriod(this.clock());
  }

  async entries(period: string = this.period()): Promise<readonly SpendEntry[]> {
    return (await this.store.read(period)).map(entry => Object.freeze({ ...entry }));
  }

  /**
   * Authorise a run against the month's budget, before the call is made.
   *
   * Returns the reservation, or a refusal naming the number and the shortfall.
   * A refusal is not an error: the caller skips the source and says why, the
   * same way it does for a source that is not due yet.
   */
  async reserve({ runKey, source, maxChargeUsd }: { runKey: string; source: string; maxChargeUsd: number }): Promise<Reservation | Refusal> {
    const period = this.period();
    const rows = await this.store.read(period);
    if (rows.some(row => row.runKey === runKey && row.kind === 'RESERVE')) {
      // A retry of the same call. Already authorised and already committed;
      // authorising it again would commit the budget twice for one run.
      return { ok: true, runKey, maxChargeUsd };
    }

    const wanted = usdToMicros(maxChargeUsd);
    const committed = this.totals(rows).committed;
    const available = this.budgetMicros - committed;
    if (wanted > available) {
      return {
        ok: false,
        shortfallUsd: microsToUsd(wanted - available),
        reason:
          `refused: this run may charge up to ${fmt(wanted)} but only ${fmt(Math.max(0, available))} of the ` +
          `${fmt(this.budgetMicros)} ${period} budget is left (short ${fmt(wanted - available)}).`
      };
    }

    await this.write({ runKey, source, kind: 'RESERVE', micros: wanted, period, measured: true, note: `authorised up to ${fmt(wanted)}` });
    return { ok: true, runKey, maxChargeUsd };
  }

  /**
   * The run finished. Charge what it cost.
   *
   * With no `actualChargeUsd` the provider did not say, so the reservation
   * stands as an upper bound rather than being quietly written down to zero.
   */
  async settle({ runKey, actualChargeUsd }: { runKey: string; actualChargeUsd?: number }): Promise<void> {
    const period = this.period();
    const rows = await this.store.read(period);
    const held = this.outstandingFor(rows, runKey);
    if (held === undefined) return; // never reserved, or already closed

    const measured = actualChargeUsd !== undefined;
    const charge = measured ? usdToMicros(actualChargeUsd) : held.micros;
    await this.write({
      runKey, source: held.source, kind: 'SETTLE', micros: charge, period, measured,
      note: measured ? 'reported by the provider' : 'provider reported no usage; the authorised cap stands as an upper bound'
    });

    const unspent = held.micros - charge;
    if (unspent > 0) {
      await this.write({ runKey, source: held.source, kind: 'RELEASE', micros: unspent, period, measured: true, note: 'unused authorisation returned' });
    }
  }

  /**
   * The run is gone and we cannot say what it cost.
   *
   * `run-sync` does not cancel the actor when the socket dies: it stays up on
   * the provider's side and bills to its own cap. Releasing the reservation
   * would record that as free, which is the one thing we know it is not.
   */
  async abandon({ runKey, reason }: { runKey: string; reason: string }): Promise<void> {
    const period = this.period();
    const rows = await this.store.read(period);
    const held = this.outstandingFor(rows, runKey);
    if (held === undefined) return;

    await this.write({
      runKey, source: held.source, kind: 'ABANDONED', micros: held.micros, period, measured: false,
      note: `${reason}; charged at the authorised cap because the provider bills whether or not we are listening`
    });
  }

  /** Reservations with nothing closing them: what a crash left behind. */
  async outstanding(period: string = this.period()): Promise<SpendEntry[]> {
    const rows = await this.store.read(period);
    const closed = new Set(rows.filter(row => row.kind !== 'RESERVE').map(row => row.runKey));
    return rows.filter(row => row.kind === 'RESERVE' && !closed.has(row.runKey));
  }

  /**
   * Close out reservations that outlived any run that could still be using them.
   *
   * A reservation older than the longest a run can take belongs to a process
   * that died between authorising the call and hearing back. The money is
   * unaccounted for, not unspent.
   *
   * Returns how many were closed.
   */
  async recoverOutstanding(period: string = this.period(), olderThanMs = 30 * 60 * 1000): Promise<number> {
    const cutoff = this.clock().getTime() - olderThanMs;
    const stale = (await this.outstanding(period)).filter(entry => new Date(entry.at).getTime() <= cutoff);
    for (const entry of stale) {
      await this.write({
        runKey: entry.runKey, source: entry.source, kind: 'ABANDONED', micros: entry.micros, period: entry.period, measured: false,
        note: 'the run never reported back; the process died between authorising the call and hearing the answer'
      });
    }
    return stale.length;
  }

  async balance(period: string = this.period()): Promise<Balance> {
    const rows = await this.store.read(period);
    const totals = this.totals(rows);
    return {
      period,
      budgetUsd: microsToUsd(this.budgetMicros),
      settledUsd: microsToUsd(totals.settled),
      measuredUsd: microsToUsd(totals.measured),
      upperBoundUsd: microsToUsd(totals.upperBound),
      abandonedUsd: microsToUsd(totals.abandoned),
      heldUsd: microsToUsd(totals.held),
      committedUsd: microsToUsd(totals.committed),
      availableUsd: microsToUsd(this.budgetMicros - totals.committed)
    };
  }

  async describe(period: string = this.period()): Promise<string> {
    const balance = await this.balance(period);
    const bound = balance.upperBoundUsd > 0 ? ` (${balance.upperBoundUsd.toFixed(2)} of it an unreported upper bound)` : '';
    return (
      `${period}: $${balance.settledUsd.toFixed(2)} spent${bound}, ` +
      `$${balance.abandonedUsd.toFixed(2)} abandoned, ` +
      `$${balance.heldUsd.toFixed(2)} held, ` +
      `$${balance.availableUsd.toFixed(2)} left of $${balance.budgetUsd.toFixed(2)}`
    );
  }

  // ------------------------------------------------------------------ internals

  private async write(entry: Omit<SpendEntry, 'at'>): Promise<void> {
    await this.store.append({ ...entry, at: this.clock().toISOString() });
  }

  private outstandingFor(rows: SpendEntry[], runKey: string): { micros: number; source: string } | undefined {
    const reserve = rows.find(row => row.runKey === runKey && row.kind === 'RESERVE');
    if (!reserve) return undefined;
    const closed = rows.some(row => row.runKey === runKey && row.kind !== 'RESERVE');
    return closed ? undefined : { micros: reserve.micros, source: reserve.source };
  }

  private totals(rows: SpendEntry[]): { settled: number; measured: number; upperBound: number; abandoned: number; held: number; committed: number } {
    let settled = 0, measured = 0, upperBound = 0, abandoned = 0;
    // Per run, not one running total. A provider that bills past the cap it was
    // given drives that run's hold below zero, and a single global counter
    // lets the overshoot cancel out somebody else's live reservation -- so the
    // month would look like it had headroom it does not have.
    const heldByRun = new Map<string, number>();
    const bump = (key: string, by: number): void => { heldByRun.set(key, (heldByRun.get(key) ?? 0) + by); };

    for (const row of rows) {
      if (row.kind === 'RESERVE') bump(row.runKey, row.micros);
      else if (row.kind === 'RELEASE') bump(row.runKey, -row.micros);
      else if (row.kind === 'SETTLE') {
        settled += row.micros;
        bump(row.runKey, -row.micros);
        if (row.measured) measured += row.micros; else upperBound += row.micros;
      } else {
        abandoned += row.micros;
        bump(row.runKey, -row.micros);
      }
    }

    let held = 0;
    for (const remaining of heldByRun.values()) held += Math.max(0, remaining);
    return { settled, measured, upperBound, abandoned, held, committed: settled + abandoned + held };
  }
}
