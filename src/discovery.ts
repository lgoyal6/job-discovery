import { config, projectRoot } from './config.js';
import { log } from './logger.js';
import { parseWatchlist } from './watchlist.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Coverage was the quiet failure: 288 of 338 watchlist companies had never
// produced a single role, because only five boards were ever configured and
// nothing measured the gap. Discovery is a command rather than a one-off script
// so the same check can be re-run whenever the watchlist grows or a company
// migrates to a different ATS.

export interface BoardHit { company: string; ats: 'greenhouse' | 'lever' | 'ashby'; board: string; jobs: number }

const PROBES = [
  { ats: 'greenhouse' as const, url: (s: string) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, count: (j: { jobs?: unknown[] }) => (Array.isArray(j?.jobs) ? j.jobs.length : 0) },
  { ats: 'lever' as const, url: (s: string) => `https://api.lever.co/v0/postings/${s}?mode=json&limit=5`, count: (j: unknown) => (Array.isArray(j) ? j.length : 0) },
  { ats: 'ashby' as const, url: (s: string) => `https://api.ashbyhq.com/posting-api/job-board/${s}`, count: (j: { jobs?: unknown[] }) => (Array.isArray(j?.jobs) ? j.jobs.length : 0) }
];

/** Board slugs are usually the company name with punctuation removed, sometimes without a legal suffix. */
export function slugCandidates(name: string): string[] {
  const base = name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const candidates = new Set([base.replace(/\s+/g, ''), base.replace(/\s+/g, '-')]);
  const trimmed = base.replace(/\b(inc|corp|corporation|technologies|technology|labs|group|holdings|company|co)\b/g, '').trim();
  if (trimmed && trimmed !== base) {
    candidates.add(trimmed.replace(/\s+/g, ''));
    candidates.add(trimmed.replace(/\s+/g, '-'));
  }
  return [...candidates].filter(slug => slug.length > 2).slice(0, 3);
}

async function probe(company: string, slug: string, spec: typeof PROBES[number]): Promise<BoardHit | null> {
  try {
    const response = await fetch(spec.url(slug), { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'laksh-job-discovery/1.0 (+personal job search)' } });
    if (!response.ok) return null;
    const jobs = spec.count(await response.json() as { jobs?: unknown[] });
    // An empty board is indistinguishable from a wrong slug, so require postings.
    return jobs > 0 ? { company, ats: spec.ats, board: slug, jobs } : null;
  } catch { return null; }
}

export async function discoverBoards(companies: string[], concurrency = 10): Promise<BoardHit[]> {
  const queue = companies.flatMap(company => slugCandidates(company).flatMap(slug => PROBES.map(spec => ({ company, slug, spec }))));
  const hits: BoardHit[] = [];
  const resolved = new Set<string>();
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      // First slug that answers wins; the rest for that company are wasted calls.
      if (resolved.has(item.company)) continue;
      const hit = await probe(item.company, item.slug, item.spec);
      if (!hit) continue;
      resolved.add(item.company);
      hits.push(hit);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return hits.sort((a, b) => a.company.localeCompare(b.company));
}

export async function configuredCompanies(): Promise<Set<string>> {
  const json = JSON.parse(await readFile(resolve(projectRoot, 'config/sources.json'), 'utf8')) as { ats?: Array<{ company: string }> };
  return new Set((json.ats ?? []).map(entry => entry.company.toLowerCase()));
}

/** Watchlist companies with no board configured yet. */
export async function unconfiguredWatchlistCompanies(): Promise<string[]> {
  const watchlist = await parseWatchlist(resolve(projectRoot, '../automation/job-company-watchlist.md'));
  const configured = await configuredCompanies();
  const names = new Set<string>();
  for (const entry of watchlist) {
    for (const name of [entry.parent, ...entry.aliases]) {
      if (name && !configured.has(name.toLowerCase())) names.add(name);
    }
  }
  return [...names];
}

// Guessing a slug from a company name only finds boards whose slug looks like
// the company. It will never produce "embed" for Cubist Systematic Strategies or
// "scm" for Stevens Capital Management. Those arrive on their own, inside the
// apply URLs of roles the community lists and LinkedIn already surface, so the
// pipeline can grow its own source list from what it has already seen.
const BOARD_URL_PATTERNS: Array<[RegExp, BoardHit['ats']]> = [
  [/(?:job-)?boards\.greenhouse\.io\/([a-z0-9_-]+)/i, 'greenhouse'],
  [/jobs\.lever\.co\/([a-z0-9_-]+)/i, 'lever'],
  [/jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i, 'ashby']
];

export function boardFromUrl(url: string): { ats: BoardHit['ats']; board: string } | null {
  for (const [pattern, ats] of BOARD_URL_PATTERNS) {
    const match = url.match(pattern);
    // Greenhouse serves /embed/job_board style paths too; those are not slugs.
    if (match?.[1] && match[1].toLowerCase() !== 'embed') return { ats, board: match[1].toLowerCase() };
  }
  return null;
}

/** Board slugs seen in apply URLs that are not configured as sources yet. */
export async function harvestBoardsFromSeenUrls(
  urls: Array<{ url: string; company: string }>,
  configured: Set<string>
): Promise<BoardHit[]> {
  const found = new Map<string, BoardHit>();
  for (const { url, company } of urls) {
    const hit = url ? boardFromUrl(url) : null;
    if (!hit) continue;
    const key = `${hit.ats}:${hit.board}`;
    if (configured.has(key) || found.has(key)) continue;
    found.set(key, { company, ats: hit.ats, board: hit.board, jobs: 0 });
  }
  // Confirm each is a live board before proposing it, so a dead or renamed slug
  // never becomes a permanently failing source.
  const confirmed: BoardHit[] = [];
  const queue = [...found.values()];
  const worker = async (): Promise<void> => {
    for (let candidate = queue.shift(); candidate; candidate = queue.shift()) {
      const spec = PROBES.find(p => p.ats === candidate.ats);
      if (!spec) continue;
      const hit = await probe(candidate.company, candidate.board, spec);
      if (hit) confirmed.push(hit);
    }
  };
  await Promise.all(Array.from({ length: config.DISCOVERY_CONCURRENCY }, worker));
  return confirmed.sort((a, b) => a.company.localeCompare(b.company));
}

export async function runDiscovery(): Promise<{ hits: BoardHit[]; probed: number }> {
  const companies = await unconfiguredWatchlistCompanies();
  log('info', 'board_discovery_start', { companies: companies.length, concurrency: config.DISCOVERY_CONCURRENCY });
  const hits = await discoverBoards(companies, config.DISCOVERY_CONCURRENCY);
  log('info', 'board_discovery_complete', { probed: companies.length, resolved: hits.length });
  return { hits, probed: companies.length };
}
