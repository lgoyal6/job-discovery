import { z } from 'zod';
import { config, projectRoot } from '../config.js';
import { fetchWithPolicy } from '../http.js';
import type { RawJob } from '../types.js';
import { SafeSource } from './base.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { extractSourceJobId } from '../normalization.js';

// Large enough that a genuinely empty list still passes, small enough that a
// full README (these run 50-160 KB) never does.
const EMPTY_PARSE_MIN_BYTES = 2000;

const sourceConfigSchema = z.object({ community: z.array(z.object({ name: z.string(), url: z.string().url(), format: z.enum(['markdown', 'html']), cycle: z.string().optional() })) });
export type CommunityConfig = z.infer<typeof sourceConfigSchema>['community'][number];

function cleanCell(cell: string): string {
  return cell.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#x200B;/g, ' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

// These READMEs mix link syntaxes and change without warning: vanshb03 and
// speedyapply both moved their table cells from [label](url) to raw <a> tags,
// which silently produced zero jobs for over a day. Accept both forms.
function links(cell: string): Array<{ label: string; url: string }> {
  const markdown = [...cell.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)[^)]*\)/g)]
    .map(match => ({ label: cleanCell(match[1] ?? ''), url: match[2] ?? '' }));
  const html = [...cell.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(match => ({ label: cleanCell(match[2] ?? ''), url: match[1] ?? '' }));
  const all = [...markdown, ...html].filter(link => link.url);
  const seen = new Set<string>();
  return all.filter(link => !seen.has(link.url) && seen.add(link.url));
}

// Simplify replaced its pipe table with a real <table>. Rows are <tr> with <td>
// cells in the same column order, so reuse the cell logic rather than the
// link-scraping HTML parser, which cannot recover the company name.
function htmlTableRows(html: string): string[][] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(row => [...(row[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => cell[1] ?? ''))
    .filter(cells => cells.length >= 3);
}

// Pipe rows when the document still has them, otherwise <tr>/<td>. Both feed
// the same column contract: company, role, location, then anything else.
function tableRows(document: string): string[][] {
  const pipe = document.split(/\r?\n/)
    .filter(line => /^\s*\|/.test(line) && !/^\s*\|?\s*:?-{3}/.test(line))
    .map(line => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim()));
  return pipe.length ? pipe : htmlTableRows(document);
}

export function parseMarkdownJobs(markdown: string, source: Pick<CommunityConfig, 'name' | 'url' | 'cycle'>, now = new Date().toISOString()): RawJob[] {
  const jobs: RawJob[] = [];
  let previousCompany = '';
  for (const cells of tableRows(markdown)) {
    const line = cells.join(' | ');
    if (cells.length < 3 || /company/i.test(cells[0] ?? '') && /role|position/i.test(cells[1] ?? '')) continue;
    // Simplify prefixes newly-added rows with 🔥. It normalizes away for identity
    // but would otherwise show up verbatim in the digest.
    let company = cleanCell(cells[0] ?? '').replace(/^[^\p{L}\p{N}(]+/u, '').trim();
    if (/^(?:↳|same|〃|\^)$/.test(company) || !company) company = previousCompany;
    else previousCompany = company;
    const title = cleanCell(cells[1] ?? '');
    const allLinks = cells.flatMap(links);
    if (!company || !title || allLinks.length === 0 || /closed/i.test(line) || /🔒/.test(line)) continue;
    const applyLink = allLinks.find(link => /apply|application/i.test(link.label)) ?? allLinks[0];
    if (!applyLink) continue;
    const location = cleanCell(cells[2] ?? 'Unspecified') || 'Unspecified';
    const sourceJobId = extractSourceJobId(applyLink.url);
    jobs.push({
      sourceName: source.name, sourceJobId, title, company, location,
      sourceUrl: source.url, directApplyUrl: applyLink.url, scrapedAt: now, cycleHint: source.cycle,
      description: cleanCell(cells.slice(3).join(' ')), raw: { row: line }
    });
  }
  return jobs;
}

export function parseHtmlJobs(html: string, source: Pick<CommunityConfig, 'name' | 'url' | 'cycle'>, now = new Date().toISOString()): RawJob[] {
  const decoded = html.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'");
  const jobs: RawJob[] = [];
  const seen = new Set<string>();
  const linkPattern = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of decoded.matchAll(linkPattern)) {
    const url = match[1] ?? '';
    const label = cleanCell(match[2] ?? '');
    if (!label || !/job|career|apply|greenhouse|lever|ashby|workday|smartrecruiters/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const context = cleanCell(decoded.slice(Math.max(0, (match.index ?? 0) - 600), (match.index ?? 0) + 600));
    const title = label.length > 4 && label.length < 180 ? label : context.slice(0, 150);
    jobs.push({ sourceName: source.name, title, company: 'Unverified company', location: 'Unspecified', description: context, sourceUrl: source.url, directApplyUrl: url, scrapedAt: now, cycleHint: source.cycle });
  }
  return jobs;
}

export class CommunitySource extends SafeSource {
  readonly name: string;
  constructor(private readonly source: CommunityConfig) { super(); this.name = source.name; }
  protected async collect(): Promise<RawJob[]> {
    const response = await fetchWithPolicy(this.source.url, { sourceName: this.name, timeoutMs: config.SOURCE_TIMEOUT_MS, retries: config.SOURCE_RETRIES, headers: { 'user-agent': 'laksh-job-discovery/1.0 (+personal job search)' } });
    const body = await response.text();
    const jobs = this.source.format === 'markdown' ? parseMarkdownJobs(body, this.source) : parseHtmlJobs(body, this.source);
    // Fail closed on a parse that yields nothing from a substantial document.
    // Upstream changing its markup is indistinguishable from "no roles today"
    // if this returns an empty array, and that silence cost a day of digests.
    if (!jobs.length && body.length > EMPTY_PARSE_MIN_BYTES) {
      throw new Error(`parsed 0 jobs from ${body.length} bytes, upstream format likely changed`);
    }
    return jobs.slice(0, config.COMMUNITY_MAX_RESULTS_PER_SOURCE);
  }
}

export async function loadCommunitySources(): Promise<CommunitySource[]> {
  const json = JSON.parse(await readFile(resolve(projectRoot, 'config/sources.json'), 'utf8'));
  return sourceConfigSchema.parse(json).community.map(source => new CommunitySource(source));
}
