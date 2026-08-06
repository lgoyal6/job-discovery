#!/usr/bin/env node
import { markBatchSent, migrate, pool } from './db.js';
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
  if (command === 'batch-sent') {
    const batchKey = flag('--batch-key');
    if (!batchKey) throw new Error('--batch-key is required');
    const marked = await markBatchSent(batchKey, flag('--message-id'));
    process.stdout.write(`${JSON.stringify({ ok: marked, batchKey })}\n`);
    return;
  }
  throw new Error('Usage: cli.ts migrate | dry-run [--fixtures|--live-free] | pipeline | batch-sent --batch-key KEY [--message-id ID]');
}

main().catch(error => { log('error', 'cli_failed', { error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }).finally(() => pool.end());
