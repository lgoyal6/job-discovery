import { z } from 'zod';
import { classifyCycle } from '../classification.js';
import { activeProfile, config, projectRoot } from '../config.js';
import { extractText } from '../enrichment.js';
import { fetchWithPolicy } from '../http.js';
import { log } from '../logger.js';
import type { RawJob } from '../types.js';
import { SafeSource } from './base.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sourceConfigSchema = z.object({ community: z.array(z.object({ name: z.string(), url: z.string().url(), format: z.string(), cycle: z.string().optional(), profile: z.enum(['technical', 'finance']).default('technical') })) });
export type InternListConfig = { name: string; url: string; cycle?: string };

// Three pages of a hundred is the whole list. The bound is here so a markup
// change that makes every page advertise a next page cannot loop.
const MAX_PAGES = 5;

// The list writes its own year - "August 18, 2026" - so unlike the markdown
// lists there is nothing to infer from the current date.
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export function parseListedDate(value: string): string | undefined {
  const match = /^([a-z]+)\s+(\d{1,2}),\s*(\d{4})$/i.exec(value.trim());
  const month = match ? MONTHS.indexOf((match[1] ?? '').toLowerCase()) : -1;
  if (!match || month < 0) return undefined;
  return new Date(Date.UTC(Number(match[3]), month, Number(match[2]))).toISOString();
}

export interface ListRow { title: string; company: string; url: string; postedAt?: string }

const cell = (chunk: string, className: string): string =>
  extractText(new RegExp(`class="${className}">([^<]*)<`).exec(chunk)?.[1] ?? '');

/**
 * Every role on this site is in the markup already: it is a Webflow collection,
 * not a client-rendered table. The generic HTML reader still found none of them,
 * because it only matched absolute hrefs and these rows are root-relative. The
 * three site promos it did match were enough to keep the empty-parse guard
 * quiet, so both lists reported SUCCESS on every run while contributing nothing.
 *
 * role="listitem" is Webflow's own attribute on a collection row. The
 * collection-item-N class beside it is renumbered whenever the layout is
 * edited, so it is not what this keys on; jobtitle, companyname_list and
 * blogtag are author-named and describe the fields they hold.
 */
export function parseListPage(html: string, listUrl: string): { rows: ListRow[]; nextUrl?: string } {
  const listPath = new URL(listUrl).pathname.replace(/\/$/, '');
  const rows: ListRow[] = [];
  const seen = new Set<string>();
  for (const chunk of html.split('<div role="listitem"').slice(1)) {
    // The logo and the text are two links to the same posting; either will do.
    const href = [...chunk.matchAll(/href="([^"]+)"/g)].map(match => match[1] ?? '').find(value => value.startsWith(`${listPath}/`));
    const title = cell(chunk, 'jobtitle');
    const company = cell(chunk, 'companyname_list');
    if (!href || !title || !company || seen.has(href)) continue;
    seen.add(href);
    rows.push({ title, company, url: new URL(href, listUrl).toString(), postedAt: parseListedDate(cell(chunk, 'blogtag')) });
  }
  // Read the next page off the pagination link rather than building the query
  // string: e3be0bc2_page is a Webflow collection id and changes if the list is
  // rebuilt.
  const nextTag = /<a\b([^>]*class="[^"]*w-pagination-next[^"]*"[^>]*)>/.exec(html)?.[1];
  const nextHref = nextTag ? /href="([^"]+)"/.exec(nextTag)?.[1] : undefined;
  return { rows, nextUrl: nextHref ? new URL(nextHref, listUrl).toString() : undefined };
}

/**
 * The list page has no location and no prose; the posting's own page has both.
 * The chips under the title are location, employment type, work mode, an
 * optional pay range and level, in that order, checked against fourteen
 * postings spanning the list's full three-month range.
 *
 * The description is the site's own summary of the posting rather than the
 * employer's text, and it never names a season or a year, so it cannot give a
 * row a cycle. It does carry the sentence the sponsorship rules read: four of
 * twelve sampled postings state "U.S. citizenship is required" or "does not
 * sponsor" outright, which without this fetch all read as "Not stated".
 */
export function parseDetailPage(html: string): { location?: string; description: string } {
  const location = extractText(/class="text-block-47">([^<]*)</.exec(html)?.[1] ?? '') || undefined;
  const start = html.indexOf('<h1');
  if (start < 0) return { location, description: '' };
  // Past the Glassdoor card it is the company blurb, a star-rating stylesheet
  // and the site footer, none of it about this posting.
  const end = html.indexOf('Glassdoor', start);
  return { location, description: extractText(html.slice(start, end > start ? end : undefined)) };
}

export class InternListSource extends SafeSource {
  readonly name: string;
  constructor(private readonly source: InternListConfig) { super(); this.name = source.name; }

  private async page(url: string): Promise<string> {
    const response = await fetchWithPolicy(url, { sourceName: this.name, timeoutMs: config.SOURCE_TIMEOUT_MS, retries: config.SOURCE_RETRIES, headers: { 'user-agent': 'laksh-job-discovery/1.0 (+personal job search)' } });
    return response.text();
  }

  protected async collect(): Promise<RawJob[]> {
    const now = new Date().toISOString();
    const rows: ListRow[] = [];
    const visited = new Set<string>();
    let next: string | undefined = this.source.url;
    while (next && !visited.has(next) && visited.size < MAX_PAGES && rows.length < config.COMMUNITY_MAX_RESULTS_PER_SOURCE) {
      visited.add(next);
      const parsed = parseListPage(await this.page(next), next);
      rows.push(...parsed.rows);
      next = parsed.nextUrl;
    }
    // Fail closed. A live list page is 90 KB of a hundred rows, so nothing
    // parsed means the markup moved, and reporting that as an empty list is the
    // silence this source spent its whole life in.
    if (!rows.length) throw new Error(`parsed 0 rows from ${visited.size} page(s), upstream markup likely changed`);

    // A row whose title names no cycle cannot reach the digest whatever its
    // page says, because the page never names one either, so it is not worth a
    // request. Same trade the Greenhouse boards make when they keep a
    // description only for a student title.
    const wanted = rows.filter(row => classifyCycle(row.title, '', this.source.cycle ?? ''));
    const wantedUrls = new Set(wanted.map(row => row.url));
    const details = new Map<string, { location?: string; description: string }>();
    let failed = 0;
    const queue = [...wanted];
    const worker = async (): Promise<void> => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        try {
          details.set(row.url, parseDetailPage(await this.page(row.url)));
        } catch (error) {
          failed += 1;
          log('warn', 'intern_list_detail_failed', { source: this.name, url: row.url, error: String(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(config.INTERN_LIST_DETAIL_CONCURRENCY, queue.length) }, worker));
    if (wanted.length && failed === wanted.length) throw new Error(`every one of ${wanted.length} detail pages failed`);

    log('info', 'intern_list_collected', { source: this.name, pages: visited.size, rows: rows.length, detailed: details.size, failedDetails: failed });
    const jobs = rows.flatMap<RawJob>(row => {
      const detail = details.get(row.url);
      // A row that was due a page and did not get one is dropped rather than
      // emitted flat. materialFingerprint is title, location and cycle: one run
      // without the location and the next with it clears sent_at and mails the
      // same role a second time.
      if (!detail && wantedUrls.has(row.url)) return [];
      return [{
        sourceName: this.name, title: row.title, company: row.company, location: detail?.location ?? 'Unspecified',
        // No directApplyUrl. This page is the list's own write-up of the role
        // and its apply button leads to a jobright.ai account wall rather than
        // to the employer, so presenting the same URL twice, once as the source
        // and once as a direct application, promised a link that does not
        // exist. It stays the source URL, which is what it honestly is.
        postedAt: row.postedAt, description: detail?.description, sourceUrl: row.url,
        scrapedAt: now, cycleHint: this.source.cycle
      }];
    });
    // No sourceJobId. The trailing number in the slug is this site's row id,
    // not the employer's requisition id, and localDedupe's req: key is scoped
    // by company rather than by source: a seven-digit id that happened to match
    // a Greenhouse one at the same company would silently drop a real role.
    // Without it the canonical key falls back to this page's own URL.
    return jobs.slice(0, config.COMMUNITY_MAX_RESULTS_PER_SOURCE);
  }
}

export async function loadInternListSources(): Promise<InternListSource[]> {
  const json = JSON.parse(await readFile(resolve(projectRoot, 'config/sources.json'), 'utf8'));
  return sourceConfigSchema.parse(json).community
    .filter(source => source.format === 'intern-list' && source.profile === activeProfile)
    .map(source => new InternListSource({ name: source.name, url: source.url, cycle: source.cycle }));
}
