import type { RawJob, SourceAdapter, SourceResult } from '../types.js';
import { log } from '../logger.js';

export abstract class SafeSource implements SourceAdapter {
  abstract readonly name: string;
  protected abstract collect(): Promise<RawJob[]>;

  async fetch(): Promise<SourceResult> {
    const startedAt = new Date();
    try {
      const jobs = await this.collect();
      const finishedAt = new Date();
      log('info', 'source_complete', { source: this.name, fetched: jobs.length, durationMs: finishedAt.getTime() - startedAt.getTime() });
      return { sourceName: this.name, status: 'SUCCESS', jobs, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime(), costUnits: 0 };
    } catch (error) {
      const finishedAt = new Date();
      log('error', 'source_failed', { source: this.name, error: String(error) });
      return { sourceName: this.name, status: 'FAILED', jobs: [], startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime(), error: error instanceof Error ? error.message : String(error), costUnits: 0 };
    }
  }
}

export function skippedSource(sourceName: string, reason: string): SourceResult {
  const now = new Date().toISOString();
  return { sourceName, status: 'SKIPPED', jobs: [], startedAt: now, finishedAt: now, durationMs: 0, error: reason, costUnits: 0 };
}
