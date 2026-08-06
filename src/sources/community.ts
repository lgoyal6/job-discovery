import { z } from 'zod';
import { config, projectRoot } from '../config.js';
import { fetchWithPolicy } from '../http.js';
import type { RawJob } from '../types.js';
import { SafeSource } from './base.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { extractSourceJobId } from '../normalization.js';

const sourceConfigSchema = z.object({ community: z.array(z.object({ name: z.string(), url: z.string().url(), format: z.enum(['markdown', 'html']), cycle: z.string().optional() })) });
export type CommunityConfig = z.infer<typeof sourceConfigSchema>['community'][number];

function cleanCell(cell: string): string {
  return cell.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#x200B;/g, ' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

function links(cell: string): Array<{ label: string; url: string }> {
  return [...cell.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)[^)]*\)/g)].map(match => ({ label: cleanCell(match[1] ?? ''), url: match[2] ?? '' }));
}

export function parseMarkdownJobs(markdown: string, source: Pick<CommunityConfig, 'name' | 'url' | 'cycle'>, now = new Date().toISOString()): RawJob[] {
  const jobs: RawJob[] = [];
  let previousCompany = '';
  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\s*\|/.test(line) || /^\s*\|?\s*:?-{3}/.test(line)) continue;
    const cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
    if (cells.length < 3 || /company/i.test(cells[0] ?? '') && /role|position/i.test(cells[1] ?? '')) continue;
    let company = cleanCell(cells[0] ?? '');
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
    return jobs.slice(0, config.COMMUNITY_MAX_RESULTS_PER_SOURCE);
  }
}

export async function loadCommunitySources(): Promise<CommunitySource[]> {
  const json = JSON.parse(await readFile(resolve(projectRoot, 'config/sources.json'), 'utf8'));
  return sourceConfigSchema.parse(json).community.map(source => new CommunitySource(source));
}
