#!/usr/bin/env node
import { getSeenApplyUrls, markBatchSent, migrate, pool } from './db.js';
import { harvestBoardsFromSeenUrls, runDiscovery } from './discovery.js';
import { runPipeline } from './pipeline.js';
import { log } from './logger.js';
import { activeProfile, financeDatabaseConfigured } from './config.js';
import { sendDiscordAudit } from './discord-audit.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'migrate') {
    const applied = await migrate();
    process.stdout.write(`${JSON.stringify({ ok: true, applied })}\n`);
    return;
  }
  if (command === 'dry-run') {
    const report = await runPipeline({ fixtures: process.argv.includes('--fixtures') || !process.argv.includes('--live-free'), liveFree: process.argv.includes('--live-free'), persistent: false });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (command === 'pipeline') {
    // Two profiles against one database would mean the second reader never sees
    // a role the first was mailed: `jobs.sent_at` is one column and
    // `email_batches` carries no recipient. A dry run has no database to share,
    // so the check belongs here rather than in the config schema.
    if (activeProfile !== 'technical' && !financeDatabaseConfigured) {
      throw new Error(`JOB_PROFILE=${activeProfile} requires FINANCE_DATABASE_URL: sharing the technical database would consume its send state`);
    }
    const report = await runPipeline({ persistent: true });
    await sendDiscordAudit(report);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  if (command === 'discover-boards') {
    // Prints entries ready to paste into config/sources.json. Deliberately does
    // not write the file: the repo is the deploy source, so board changes should
    // be reviewed and committed rather than appearing from a container.
    const { hits, probed } = await runDiscovery();
    const entries = hits.map(hit => hit.ats === 'lever'
      ? { type: hit.ats, site: hit.board, company: hit.company }
      : { type: hit.ats, board: hit.board, company: hit.company });
    process.stdout.write(`${JSON.stringify({ probed, resolved: hits.length, entries }, null, 2)}\n`);
    return;
  }
  if (command === 'harvest-boards') {
    // Slugs cannot be guessed from company names, but they appear verbatim in
    // the apply URLs of roles already collected. This turns those into sources.
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const { projectRoot } = await import('./config.js');
    const cfg = JSON.parse(await readFile(resolve(projectRoot, 'config/sources.json'), 'utf8')) as { ats?: Array<Record<string, string>> };
    const { boardKey } = await import('./discovery.js');
    const configured = new Set((cfg.ats ?? []).map(a => {
      if (a.type === 'lever') return `lever:${(a.site ?? '').toLowerCase()}`;
      if (a.type === 'smartrecruiters') return `smartrecruiters:${(a.companyId ?? '').toLowerCase()}`;
      if (a.type === 'workday') return `workday:${a.tenant}:${a.site}`;
      if (a.type === 'oracle') return `oracle:${a.host}:${a.site}`;
      return `${a.type}:${(a.board ?? '').toLowerCase()}`;
    }));
    const hits = await harvestBoardsFromSeenUrls(await getSeenApplyUrls(), configured);
    const entries = hits.map(h => ({ ...h.board, type: h.board.ats, ats: undefined, company: h.company, postings: h.jobs }));
    process.stdout.write(`${JSON.stringify({ newBoards: hits.length, entries }, null, 2)}\n`);
    void boardKey;
    return;
  }
  if (command === 'mark-applied') {
    // Reached from a link in the digest, so a refused click is an answer to
    // render, not a crash: exit 0 with ok:false and let the webhook say why.
    const { markApplied } = await import('./applied.js');
    const result = await markApplied(flag('--job') ?? '', flag('--sig') ?? '');
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'batch-sent') {
    const batchKey = flag('--batch-key');
    if (!batchKey) throw new Error('--batch-key is required');
    const marked = await markBatchSent(batchKey, flag('--message-id'));
    process.stdout.write(`${JSON.stringify({ ok: marked, batchKey })}\n`);
    return;
  }
  throw new Error('Usage: cli.ts migrate | dry-run [--fixtures|--live-free] | pipeline | discover-boards | harvest-boards | mark-applied --job ID --sig SIG | batch-sent --batch-key KEY [--message-id ID]');
}

main().catch(error => { log('error', 'cli_failed', { error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }).finally(() => pool.end());
