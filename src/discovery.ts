import { config, projectRoot, watchlistPath } from './config.js';
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
  const watchlist = await parseWatchlist(watchlistPath);
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
const BOARD_URL_PATTERNS: Array<[RegExp, 'greenhouse' | 'lever' | 'ashby']> = [
  [/(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)/i, 'greenhouse'],
  [/jobs\.lever\.co\/([a-z0-9_-]+)/i, 'lever'],
  [/jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i, 'ashby']
];

/**
 * A board descriptor read straight out of an apply link.
 *
 * Workday was written off as undiscoverable after probing 44 investment firms
 * by slug found exactly one: a tenant is not derived from a company name, and
 * the site segment beside it is arbitrary. Both are spelled out in every apply
 * URL the lists publish. nvidia.wd5, intel.wd1, capitalone.wd12 and
 * lplfinancial.wd1 were all sitting in the database while the harvester only
 * knew how to read three hosts. The same is true of SmartRecruiters, whose
 * adapter has existed unused since the beginning, and of Oracle, where the
 * pipeline had one site configured by hand and JPMorgan's was there for the
 * taking.
 */
export type HarvestedBoard =
  | { ats: 'greenhouse'; board: string }
  | { ats: 'ashby'; board: string }
  | { ats: 'lever'; site: string }
  | { ats: 'smartrecruiters'; companyId: string }
  | { ats: 'workday'; host: string; tenant: string; site: string }
  | { ats: 'oracle'; host: string; site: string };

export function boardFromUrl(url: string): HarvestedBoard | null {
  for (const [pattern, ats] of BOARD_URL_PATTERNS) {
    const match = url.match(pattern);
    // Greenhouse serves /embed/job_board style paths too; those are not slugs.
    if (match?.[1] && match[1].toLowerCase() !== 'embed') {
      const slug = match[1].toLowerCase();
      if (ats === 'lever') return { ats, site: slug };
      return ats === 'greenhouse' ? { ats, board: slug } : { ats, board: slug };
    }
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const segments = parsed.pathname.split('/').filter(Boolean);

  // https://{tenant}.wd{n}.myworkdayjobs.com/[en-US/]{site}/job/...
  const workday = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i.exec(parsed.hostname);
  if (workday) {
    const jobIndex = segments.indexOf('job');
    const site = jobIndex > 0 ? segments[jobIndex - 1] : undefined;
    // The locale is a path segment too, and it is never the site.
    if (site && !/^[a-z]{2}-[A-Z]{2}$/.test(site)) {
      return { ats: 'workday', host: `https://${parsed.hostname}`, tenant: workday[1]!.toLowerCase(), site };
    }
    return null;
  }
  // https://jobs.smartrecruiters.com/{companyId}/{postingId}
  if (/^jobs\.smartrecruiters\.com$/i.test(parsed.hostname) && segments[0]) {
    return { ats: 'smartrecruiters', companyId: segments[0] };
  }
  // https://{host}/hcmUI/CandidateExperience/{locale}/sites/{site}/job/{id}
  if (/\.oraclecloud\.com$/i.test(parsed.hostname)) {
    const sitesIndex = segments.indexOf('sites');
    const site = sitesIndex >= 0 ? segments[sitesIndex + 1] : undefined;
    if (site) return { ats: 'oracle', host: `https://${parsed.hostname}`, site };
  }
  return null;
}

/** The identity two descriptors share when they are the same board. */
export function boardKey(board: HarvestedBoard): string {
  if (board.ats === 'lever') return `lever:${board.site}`;
  if (board.ats === 'smartrecruiters') return `smartrecruiters:${board.companyId.toLowerCase()}`;
  if (board.ats === 'workday') return `workday:${board.tenant}:${board.site}`;
  if (board.ats === 'oracle') return `oracle:${board.host}:${board.site}`;
  return `${board.ats}:${board.board}`;
}

export interface HarvestedSource { company: string; board: HarvestedBoard; jobs: number }

/**
 * Confirms a harvested descriptor is live, by asking it for postings the same
 * way the adapter will. A dead or renamed slug must never become a permanently
 * failing source, and the shapes differ enough per family to be worth spelling
 * out rather than sharing one probe.
 */
async function confirm(board: HarvestedBoard): Promise<number> {
  const get = async (url: string, init?: RequestInit): Promise<any> => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'laksh-job-discovery/1.0 (+personal job search)' }, ...init });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  };
  if (board.ats === 'greenhouse') return (await get(`https://boards-api.greenhouse.io/v1/boards/${board.board}/jobs`))?.jobs?.length ?? 0;
  if (board.ats === 'ashby') return (await get(`https://api.ashbyhq.com/posting-api/job-board/${board.board}`))?.jobs?.length ?? 0;
  if (board.ats === 'lever') { const body = await get(`https://api.lever.co/v0/postings/${board.site}?mode=json&limit=5`); return Array.isArray(body) ? body.length : 0; }
  if (board.ats === 'smartrecruiters') return (await get(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board.companyId)}/postings?limit=5`))?.content?.length ?? 0;
  if (board.ats === 'workday') {
    const body = await get(`${board.host}/wday/cxs/${board.tenant}/${board.site}/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' })
    });
    return Array.isArray(body?.jobPostings) ? body.jobPostings.length : 0;
  }
  const finder = `findReqs;siteNumber=${board.site},limit=5,offset=0,sortBy=POSTING_DATES_DESC`;
  const body = await get(`${board.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=${encodeURIComponent(finder)}`);
  return body?.items?.[0]?.requisitionList?.length ?? 0;
}

/** Board descriptors seen in apply URLs that are not configured as sources yet. */
export async function harvestBoardsFromSeenUrls(
  urls: Array<{ url: string; company: string }>,
  configured: Set<string>
): Promise<HarvestedSource[]> {
  const found = new Map<string, HarvestedSource>();
  for (const { url, company } of urls) {
    const board = url ? boardFromUrl(url) : null;
    if (!board) continue;
    const key = boardKey(board);
    if (configured.has(key) || found.has(key)) continue;
    found.set(key, { company, board, jobs: 0 });
  }
  const confirmed: HarvestedSource[] = [];
  const queue = [...found.values()];
  const worker = async (): Promise<void> => {
    for (let candidate = queue.shift(); candidate; candidate = queue.shift()) {
      const jobs = await confirm(candidate.board);
      if (jobs > 0) confirmed.push({ ...candidate, jobs });
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
