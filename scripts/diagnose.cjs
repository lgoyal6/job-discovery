// Runs INSIDE the n8n container. Dumps why the digest did or did not send.
//
// n8n only prints *errors* to stdout, and the useful part of a node failure —
// the provider's own message — never reaches the container log at all. It lives
// in execution_data, flatted-encoded. That gap is what made a 403 look like
// silence for twelve hours, so this reads the execution record directly.
//
// Invoked by scripts/diagnose.sh; not part of the deployed image.
const { Client } = require('/opt/job-pipeline/node_modules/pg');
const { parse } = require('/usr/local/lib/node_modules/n8n/node_modules/.pnpm/flatted@3.4.2/node_modules/flatted');

const LIMIT = Number(process.env.DIAGNOSE_LIMIT || 12);
const TZ = 'America/Los_Angeles';
const fmt = d => d
  ? new Date(d).toLocaleString('en-US', { timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  : '—';

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const ex = await c.query(
    'SELECT id, status, mode, "startedAt", "stoppedAt" FROM execution_entity ORDER BY "startedAt" DESC LIMIT $1', [LIMIT]);
  const ids = ex.rows.map(r => r.id);
  const datas = ids.length
    ? await c.query('SELECT "executionId", data FROM execution_data WHERE "executionId" = ANY($1)', [ids])
    : { rows: [] };
  const byId = new Map(datas.rows.map(r => [r.executionId, r.data]));

  console.log('=== EXECUTIONS (newest first) ===');
  for (const r of ex.rows) {
    const mark = r.status === 'error' ? 'FAIL' : r.status === 'success' ? 'ok  ' : r.status;
    console.log(`#${String(r.id).padEnd(4)} ${mark}  ${fmt(r.startedAt)}  ${r.mode}`);
    let d;
    try { d = parse(String(byId.get(r.id) ?? '')); } catch { continue; }
    const runData = d?.resultData?.runData || {};
    for (const [node, runs] of Object.entries(runData)) {
      for (const run of runs) {
        if (run.executionStatus !== 'error' && !run.error) continue;
        const e = run.error || {};
        console.log(`       node "${node}" failed`);
        if (e.message) console.log(`         message:     ${e.message}`);
        // The provider's real explanation. This is the field worth having.
        if (e.description) console.log(`         description: ${String(e.description).replace(/\s+/g, ' ').slice(0, 500)}`);
        if (e.httpCode) console.log(`         httpCode:    ${e.httpCode}`);
      }
    }
    // A run that ends here sent nothing because the IF gate saw no claimed batch,
    // which is normal-and-quiet, not a failure. Worth distinguishing.
    const last = d?.resultData?.lastNodeExecuted;
    if (r.status !== 'error' && last === 'Has Claimed New Roles?') {
      console.log('       stopped at IF gate — nothing claimed, no email (expected when digest is unchanged)');
    }
  }

  const b = await c.query(
    'SELECT batch_key, status, cardinality(job_ids) AS jobs, claimed_at, sent_at, provider_message_id FROM email_batches ORDER BY claimed_at DESC LIMIT 8');
  console.log('\n=== EMAIL BATCHES ===');
  if (!b.rows.length) console.log('  (none)');
  for (const r of b.rows) {
    console.log(`  ${r.batch_key}  ${r.status}  jobs=${r.jobs}  claimed=${fmt(r.claimed_at)}  sent=${fmt(r.sent_at)}  msg=${r.provider_message_id || '—'}`);
  }

  // Coverage first: a source can be green while most target companies are absent.
  const cov = await c.query(
    "SELECT metrics, finished_at FROM source_runs WHERE source_name='watchlist-rotation' ORDER BY started_at DESC LIMIT 1");
  const m = cov.rows[0]?.metrics;
  if (m) {
    console.log('\n=== WATCHLIST COVERAGE ===');
    console.log(`  ${m.watchlistCompaniesWithRoles ?? '?'} of ${m.totalCompanies ?? '?'} target companies returned roles (${m.watchlistCoveragePercent ?? '?'}%)`);
  }

  const s = await c.query(
    'SELECT source_name, status, fetched_count, accepted_count, error_message, finished_at FROM source_runs ORDER BY started_at DESC LIMIT 12');
  console.log('\n=== RECENT SOURCE RUNS ===');
  for (const r of s.rows) {
    console.log(`  ${fmt(r.finished_at)}  ${String(r.source_name).padEnd(22)} ${String(r.status).padEnd(8)} fetched=${r.fetched_count} accepted=${r.accepted_count} ${r.error_message || ''}`);
  }

  await c.end();
})().catch(e => { console.error('DIAGNOSE FAILED:', e.message); process.exit(1); });
