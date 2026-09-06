/**
 * The two halves of the mirror outbox as separate processes, so the relay can
 * be killed without taking the consumer with it and the consumer's database is
 * genuinely a different database.
 *
 * Run with tsx, straight from source: there is no build artefact to go stale
 * between a change and the run that is supposed to exercise it.
 *
 *   tsx src/outbox-cli.ts migrate    -db $DB
 *   tsx src/outbox-cli.ts sink       -db $SINK_DB -port 9412 [-dedupe false]
 *   tsx src/outbox-cli.ts seed       -db $DB -n 3
 *   tsx src/outbox-cli.ts claim      -db $DB [-crash after_commit]
 *   tsx src/outbox-cli.ts relay      -db $DB -sink http://127.0.0.1:9412 [-crash before_send|after_send]
 *   tsx src/outbox-cli.ts reconcile  -db $DB -sink ... [-no-lookup]
 *   tsx src/outbox-cli.ts dual-write -db $DB -sink ... [-crash after_send]
 *   tsx src/outbox-cli.ts status     -db $DB
 *
 * -db is always explicit and this file never imports config.ts, so no
 * invocation can reach the pipeline's real database by inheriting an
 * environment variable.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { outboxCounts, type CrashPoint, type Crasher } from './outbox.js';
import { HttpLedgerSink, LedgerSink } from './outbox-sink.js';
import { claimJobsForMirror, mirrorDualWrite, mirrorRelay } from './outbox-mirror.js';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string, fallback = ''): string => {
  const index = args.indexOf(`-${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] as string : fallback;
};
const has = (name: string): boolean => args.includes(`-${name}`);

/**
 * Really kills this process at the named point.
 *
 * SIGKILL, not an exception and not process.exit: a thrown error runs catch and
 * finally blocks and an exit flushes stdout, and either would let the process
 * tidy up in a way an OOM kill never would. What survives is only what Postgres
 * already committed. Atomics.wait parks the main thread so nothing after the
 * kill can run if the signal is delivered a moment late.
 */
const killer = (point: string): Crasher | undefined => {
  if (!point) return undefined;
  return (reached: CrashPoint) => {
    if (reached !== point) return;
    process.stderr.write(`crash point ${reached} reached; SIGKILL to pid ${process.pid}\n`);
    process.kill(process.pid, 'SIGKILL');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
};

const connect = (url: string): pg.Pool => {
  if (!url) { console.error('-db is required'); process.exit(2); }
  return new pg.Pool({ connectionString: url, max: 4 });
};

async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
  for (const file of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file]);
    if (done.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(resolve(migrationsDir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
      await client.query('COMMIT');
      console.log('applied', file);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}

/**
 * Fixture rows only, invented here. This harness never reads, copies or moves
 * a row from the owner's real job-application database; the crash tests need
 * three jobs called "Fixture Co", not his.
 */
async function seed(pool: pg.Pool, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs(id, canonical_key, company, normalized_company, title, normalized_title,
                        normalized_location, cycle, category, sponsorship_status, status, first_seen_at)
       VALUES($1,$2,$3,$4,$5,$6,'unspecified','Summer 2026','SWE','UNKNOWN','OPEN',
              now() + make_interval(secs => $7::double precision))`,
      [id, `fixture-co-${index}|fixture-engineer-${index}`, `Fixture Co ${index}`, `fixture co ${index}`,
       `Fixture Engineer ${index}`, `fixture engineer ${index}`, index]);
    await pool.query(
      `INSERT INTO job_sources(job_id, source_name, source_job_id, source_url, direct_apply_url, scraped_at)
       VALUES($1,'fixtures',$2,$3,$3, now())`,
      [id, `fx-${index}`, `https://example.invalid/fixture/${index}`]);
    console.log('seeded', id);
  }
}

async function main(): Promise<void> {
  const sinkUrl = flag('sink');
  const crash = flag('crash');
  const leaseMs = Number(flag('lease', '30000'));
  const pool = connect(flag('db', ''));

  switch (command) {
    case 'migrate':
      await migrate(pool);
      break;
    case 'migrate-sink':
      await new LedgerSink(pool).migrate();
      console.log('sink schema ready');
      break;
    case 'sink': {
      const dedupe = flag('dedupe', 'true') !== 'false';
      const sink = new LedgerSink(pool, dedupe);
      await sink.migrate();
      await sink.listen(Number(flag('port', '9412')));
      console.log(`ledger sink listening on ${flag('port', '9412')} (dedupe=${String(dedupe)})`);
      return; // stays up
    }
    case 'seed':
      await seed(pool, Number(flag('n', '3')));
      break;
    case 'claim': {
      const claimed = await claimJobsForMirror(pool, Number(flag('limit', '100')), flag('status', 'Found'), killer(crash));
      console.log(`claimed ${claimed.length} role(s)`);
      break;
    }
    case 'relay': {
      const relay = mirrorRelay(pool, new HttpLedgerSink(sinkUrl), { leaseMs, crash: killer(crash) });
      console.log('pass', JSON.stringify(await relay.once()));
      break;
    }
    case 'reconcile': {
      const relay = mirrorRelay(pool, new HttpLedgerSink(sinkUrl, has('no-lookup')), { leaseMs });
      console.log(`expired ${await relay.expireLeases()} lease(s) into UNKNOWN`);
      console.log('reconcile', JSON.stringify(await relay.reconcile()));
      break;
    }
    case 'dual-write': {
      const created = await mirrorDualWrite(pool, Number(flag('limit', '100')), flag('status', 'Found'), new HttpLedgerSink(sinkUrl), killer(crash));
      console.log(`dual-write filed ${created} page(s)`);
      break;
    }
    case 'status':
      console.log('outbox', JSON.stringify(await outboxCounts(pool)));
      break;
    default:
      console.error('usage: outbox-cli <migrate|migrate-sink|sink|seed|claim|relay|reconcile|dual-write|status> [flags]');
      process.exit(2);
  }
  await pool.end();
}

main().catch((error: unknown) => { console.error('error:', error instanceof Error ? error.message : String(error)); process.exit(1); });
