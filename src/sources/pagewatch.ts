import { z } from 'zod';
import { config, projectRoot } from '../config.js';
import { extractText } from '../enrichment.js';
import { log } from '../logger.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// A page changing is not a job posting, so this deliberately does not produce
// RawJobs. Forcing an announcement through the job classifier would mean
// dressing it up as a role to survive rules written for roles; instead these
// surface as their own section in the digest.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36';

// Below this, a "page" is a redirect stub, a cookie wall, or an error body.
// Hashing one of those makes every later fetch look like a change.
const MIN_TEXT_LENGTH = 500;

const watchConfigSchema = z.object({
  watchPages: z.array(z.object({
    url: z.string().url(),
    company: z.string(),
    label: z.string().default('')
  })).default([])
});
export type WatchPage = z.infer<typeof watchConfigSchema>['watchPages'][number];

export interface PageWatchResult {
  url: string;
  company: string;
  label: string;
  hash: string;
  textLength: number;
  httpOk: boolean;
  error?: string;
}

export interface PageChange { url: string; company: string; label: string; previousLength: number; textLength: number }

export function hashPageText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function checkOne(page: WatchPage): Promise<PageWatchResult> {
  const base = { url: page.url, company: page.company, label: page.label, hash: '', textLength: 0, httpOk: false };
  try {
    const response = await fetch(page.url, {
      signal: AbortSignal.timeout(config.PAGEWATCH_TIMEOUT_MS),
      redirect: 'follow',
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' }
    });
    if (!response.ok) return { ...base, error: `HTTP ${response.status}` };
    const text = extractText(await response.text());
    if (text.length < MIN_TEXT_LENGTH) return { ...base, httpOk: true, textLength: text.length, error: `only ${text.length} characters of text` };
    return { url: page.url, company: page.company, label: page.label, hash: hashPageText(text), textLength: text.length, httpOk: true };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Fetches every watched page. Never throws: a watch is an extra signal, not a precondition for a digest. */
export async function checkWatchedPages(pages: WatchPage[]): Promise<PageWatchResult[]> {
  const results: PageWatchResult[] = [];
  const queue = [...pages];
  const worker = async (): Promise<void> => {
    for (let page = queue.shift(); page; page = queue.shift()) results.push(await checkOne(page));
  };
  await Promise.all(Array.from({ length: Math.min(config.PAGEWATCH_CONCURRENCY, pages.length || 1) }, worker));
  log('info', 'pagewatch_complete', {
    checked: results.length,
    readable: results.filter(result => result.hash).length,
    unreadable: results.filter(result => !result.hash).length
  });
  return results;
}

export async function loadWatchPages(): Promise<WatchPage[]> {
  if (!config.PAGEWATCH_ENABLED) return [];
  const json = JSON.parse(await readFile(resolve(projectRoot, 'config/sources.json'), 'utf8'));
  return watchConfigSchema.parse(json).watchPages;
}
