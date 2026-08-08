#!/usr/bin/env node
import { markBatchSent, migrate, pool } from './db.js';
import { runDiscovery } from './discovery.js';
import { runPipeline } from './pipeline.js';
import { log } from './logger.js';

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
    const report = await runPipeline({ persistent: true });
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
  if (command === 'batch-sent') {
    const batchKey = flag('--batch-key');
    if (!batchKey) throw new Error('--batch-key is required');
    const marked = await markBatchSent(batchKey, flag('--message-id'));
    process.stdout.write(`${JSON.stringify({ ok: marked, batchKey })}\n`);
    return;
  }
  throw new Error('Usage: cli.ts migrate | dry-run [--fixtures|--live-free] | pipeline | discover-boards | batch-sent --batch-key KEY [--message-id ID]');
}

main().catch(error => { log('error', 'cli_failed', { error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }).finally(() => pool.end());
