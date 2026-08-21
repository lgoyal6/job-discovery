import { z } from 'zod';
import { activeProfile, config, projectRoot } from '../config.js';
import { log } from '../logger.js';
import type { RawJob } from '../types.js';
import { SafeSource } from './base.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// LinkedIn's public guest job search. No account, no cookie, no token: this
// endpoint serves the same fragments an anonymous browser receives.
//
// Authenticating would be the version that gets an account restricted, and the
// account belongs to someone actively applying through it, so nothing here ever
// sends credentials. If this file ever grows a cookie header, that is a bug.
const GUEST_SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

// Cards arrive ten to a page regardless of the step used, so paging by ten is
// what avoids silently skipping results.
const PAGE_SIZE = 10;

/**
 * One request at a time, across every LinkedIn query in the run.
 *
 * The guest endpoint rate-limits per address rather than per search, and the
 * source pool runs four queries concurrently, so they were competing for a
 * single budget: ten finance queries paging ten deep earned a 429 partway
 * through a run, and the two queries still waiting their turn returned nothing
 * at all. A query that yields 50 rows every run is worth more than one that
 * yields 100 sometimes and 0 otherwise.
 *
 * The delay is held inside the gate, which is what makes it a floor on the
 * interval between consecutive requests rather than a floor per query. The pace
 * is now the same whether one query is configured or twenty.
 */
let requestGate: Promise<unknown> = Promise.resolve();
export function paced<T>(work: () => Promise<T>): Promise<T> {
  const result = requestGate.then(work, work);
  // A failed request must not wedge the queue, so the gate tracks completion
  // rather than success.
  requestGate = result.then(() => new Promise(done => setTimeout(done, config.LINKEDIN_REQUEST_DELAY_MS)), () => undefined);
  return result;
}

const linkedinConfigSchema = z.object({
  linkedin: z.array(z.object({
    name: z.string(),
    keywords: z.string(),
    location: z.string().default('United States'),
    cycle: z.string().optional(),
    // A query belongs to one digest: "software engineer intern" returns nothing
    // the finance rules accept, and "equity research internship" returns
    // nothing the technical rules do.
    profile: z.enum(['technical', 'finance']).default('technical'),
    // How deep to page, when LINKEDIN_PAGES_PER_QUERY is the wrong depth for
    // this particular search. That default is five, measured against the
    // technical queries, where relevance decays sharply with depth because the
    // keywords match loosely. The finance searches do not behave that way:
    // counted over a 24-hour window, "equity research internship" has 79
    // distinct postings, "investment analyst intern" has 98 and "private equity
    // internship" 63, so five pages was discarding about half of every one of
    // them before the digest's own rules ever saw a row.
    pages: z.coerce.number().int().min(1).max(40).optional()
  })).default([])
});
export type LinkedInQuery = z.infer<typeof linkedinConfigSchema>['linkedin'][number];

function firstMatch(card: string, pattern: RegExp): string {
  return (card.match(pattern)?.[1] ?? '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

export function parseLinkedInCards(html: string, source: Pick<LinkedInQuery, 'name' | 'cycle'>, now = new Date().toISOString()): RawJob[] {
  const jobs: RawJob[] = [];
  for (const card of html.split(/<li>/).slice(1)) {
    const jobId = firstMatch(card, /data-entity-urn="urn:li:jobPosting:(\d+)"/);
    const title = firstMatch(card, /<h3[^>]*base-search-card__title[^>]*>([\s\S]*?)<\/h3>/);
    const company = firstMatch(card, /<h4[^>]*base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/);
    const location = firstMatch(card, /<span[^>]*job-search-card__location[^>]*>([\s\S]*?)<\/span>/);
    const href = (card.match(/<a[^>]*base-card__full-link[^>]*href="([^"]+)"/)?.[1] ?? '').replace(/&amp;/g, '&');
    const postedAt = card.match(/<time[^>]*datetime="([\d-]+)"/)?.[1];
    if (!jobId || !title || !company) continue;
    // Strip LinkedIn's per-impression tracking so the same posting seen twice
    // canonicalises identically.
    const url = (href ? href.split('?')[0] : '') || `https://www.linkedin.com/jobs/view/${jobId}`;
    jobs.push({
      sourceName: source.name, sourceJobId: jobId, title, company,
      location: location || 'Unspecified',
      postedAt: postedAt ? new Date(`${postedAt}T00:00:00Z`).toISOString() : undefined,
      sourceUrl: url, directApplyUrl: url, scrapedAt: now, cycleHint: source.cycle
    });
  }
  return jobs;
}

export class LinkedInGuestSource extends SafeSource {
  readonly name: string;
  constructor(private readonly query: LinkedInQuery) { super(); this.name = query.name; }

  protected async collect(): Promise<RawJob[]> {
    const jobs: RawJob[] = [];
    const seen = new Set<string>();
    let firstPageBytes = 0;
    let throttled = false;

    const pageBudget = this.query.pages ?? config.LINKEDIN_PAGES_PER_QUERY;
    for (let page = 0; page < pageBudget; page += 1) {
      const url = `${GUEST_SEARCH}?keywords=${encodeURIComponent(this.query.keywords)}`
        + `&location=${encodeURIComponent(this.query.location)}`
        + `&f_TPR=r${config.LINKEDIN_RECENCY_SECONDS}`
        + `&start=${page * PAGE_SIZE}`;
      const response = await paced(() => fetch(url, {
        signal: AbortSignal.timeout(config.SOURCE_TIMEOUT_MS),
        headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' }
      }));
      // A 429 means back off for the rest of this run rather than push harder.
      // Egress here is one fixed address, so earning a block costs every source.
      if (response.status === 429) { throttled = true; break; }
      if (!response.ok) break;
      const body = await response.text();
      if (page === 0) firstPageBytes = body.length;
      const parsed = parseLinkedInCards(body, this.query);
      let added = 0;
      for (const job of parsed) {
        if (job.sourceJobId && seen.has(job.sourceJobId)) continue;
        if (job.sourceJobId) seen.add(job.sourceJobId);
        jobs.push(job); added += 1;
      }
      // Short page means the result set is exhausted; stop rather than spend
      // requests on pages that repeat the tail.
      if (added === 0 || parsed.length < PAGE_SIZE) break;
    }

    // An undocumented endpoint changing its markup looks exactly like a quiet
    // day unless a full page that parsed to nothing is treated as a failure.
    if (!jobs.length && firstPageBytes > 2000) {
      throw new Error(`parsed 0 job cards from ${firstPageBytes} bytes, LinkedIn markup likely changed`);
    }
    if (throttled) log('warn', 'linkedin_throttled', { source: this.name, collected: jobs.length });
    return jobs.slice(0, config.COMMUNITY_MAX_RESULTS_PER_SOURCE);
  }
}

export async function loadLinkedInSources(): Promise<LinkedInGuestSource[]> {
  if (!config.LINKEDIN_ENABLED) return [];
  const json = JSON.parse(await readFile(resolve(projectRoot, 'config/sources.json'), 'utf8'));
  return linkedinConfigSchema.parse(json).linkedin
    .filter(query => query.profile === activeProfile)
    .map(query => new LinkedInGuestSource(query));
}
