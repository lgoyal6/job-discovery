import { z } from 'zod';
import { config } from '../config.js';
import { fetchWithPolicy } from '../http.js';
import type { RawJob } from '../types.js';
import { SafeSource } from './base.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from '../config.js';

export type AtsConfig =
  | { type: 'greenhouse'; board: string; company: string }
  | { type: 'lever'; site: string; company: string }
  | { type: 'ashby'; board: string; company: string }
  | { type: 'smartrecruiters'; companyId: string; company: string }
  | { type: 'workday'; host: string; tenant: string; site: string; company: string }
  | { type: 'icims' | 'oracle' | 'successfactors' | 'eightfold' | 'career-page'; company: string; endpoint: string; method?: 'GET' | 'POST'; body?: unknown };

const greenhouseSchema = z.object({ jobs: z.array(z.object({ id: z.union([z.string(), z.number()]), title: z.string(), absolute_url: z.string().url(), updated_at: z.string().optional(), location: z.object({ name: z.string() }), content: z.string().optional() })) });
const leverSchema = z.array(z.object({ id: z.string(), text: z.string(), hostedUrl: z.string().url(), applyUrl: z.string().url().optional(), createdAt: z.number().optional(), categories: z.object({ location: z.string().optional(), commitment: z.string().optional() }).passthrough(), descriptionPlain: z.string().optional() }));
const ashbySchema = z.object({ jobs: z.array(z.object({ id: z.string().optional(), title: z.string(), location: z.string().optional(), publishedAt: z.string().optional(), jobUrl: z.string().url(), applyUrl: z.string().url().optional(), descriptionPlain: z.string().optional(), employmentType: z.string().optional() })) });
const smartSchema = z.object({ content: z.array(z.object({ id: z.string(), name: z.string(), ref: z.string().url(), releasedDate: z.string().optional(), location: z.object({ city: z.string().optional(), region: z.string().optional(), country: z.string().optional() }).optional() })), totalFound: z.number().optional() });

export function normalizeGreenhouse(payload: unknown, cfg: Extract<AtsConfig, { type: 'greenhouse' }>, now: string): RawJob[] {
  return greenhouseSchema.parse(payload).jobs.map(job => ({ sourceName: `greenhouse:${cfg.board}`, sourceJobId: String(job.id), company: cfg.company, title: job.title, location: job.location.name, postedAt: job.updated_at, description: job.content, sourceUrl: job.absolute_url, directApplyUrl: job.absolute_url, scrapedAt: now, employmentType: 'Internship' }));
}

export function normalizeLever(payload: unknown, cfg: Extract<AtsConfig, { type: 'lever' }>, now: string): RawJob[] {
  return leverSchema.parse(payload).map(job => ({ sourceName: `lever:${cfg.site}`, sourceJobId: job.id, company: cfg.company, title: job.text, location: job.categories.location, postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : undefined, description: job.descriptionPlain, employmentType: job.categories.commitment, sourceUrl: job.hostedUrl, directApplyUrl: job.applyUrl ?? job.hostedUrl, scrapedAt: now }));
}

export function normalizeAshby(payload: unknown, cfg: Extract<AtsConfig, { type: 'ashby' }>, now: string): RawJob[] {
  return ashbySchema.parse(payload).jobs.map(job => ({ sourceName: `ashby:${cfg.board}`, sourceJobId: job.id, company: cfg.company, title: job.title, location: job.location, postedAt: job.publishedAt, description: job.descriptionPlain, employmentType: job.employmentType, sourceUrl: job.jobUrl, directApplyUrl: job.applyUrl ?? job.jobUrl, scrapedAt: now }));
}

export function normalizeSmartRecruiters(payload: unknown, cfg: Extract<AtsConfig, { type: 'smartrecruiters' }>, now: string): RawJob[] {
  return smartSchema.parse(payload).content.map(job => ({ sourceName: `smartrecruiters:${cfg.companyId}`, sourceJobId: job.id, company: cfg.company, title: job.name, location: [job.location?.city, job.location?.region, job.location?.country].filter(Boolean).join(', ') || 'Unspecified', postedAt: job.releasedDate, sourceUrl: job.ref, directApplyUrl: job.ref, scrapedAt: now }));
}

function genericItems(payload: unknown): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, any>;
  for (const key of ['jobs', 'jobPostings', 'items', 'results', 'positions', 'content']) if (Array.isArray(obj[key])) return obj[key];
  return [];
}

export class AtsSource extends SafeSource {
  readonly name: string;
  constructor(private readonly source: AtsConfig) {
    super();
    const identifier = source.type === 'greenhouse' ? source.board : source.type === 'lever' ? source.site : source.type === 'ashby' ? source.board : source.type === 'smartrecruiters' ? source.companyId : source.company;
    this.name = `${source.type}:${identifier}`;
  }
  protected async collect(): Promise<RawJob[]> {
    const now = new Date().toISOString();
    let url: string;
    let init: RequestInit = {};
    if (this.source.type === 'lever') {
      const jobs: RawJob[] = [];
      for (let skip = 0; skip < config.ATS_MAX_RESULTS_PER_SOURCE; skip += 100) {
        const limit = Math.min(100, config.ATS_MAX_RESULTS_PER_SOURCE - skip);
        const endpoint = `https://api.lever.co/v0/postings/${encodeURIComponent(this.source.site)}?mode=json&limit=${limit}&skip=${skip}`;
        const response = await fetchWithPolicy(endpoint, { sourceName: this.name, timeoutMs: config.SOURCE_TIMEOUT_MS, retries: config.SOURCE_RETRIES });
        const page = normalizeLever(await response.json(), this.source, now);
        jobs.push(...page);
        if (page.length < limit) break;
      }
      return jobs;
    }
    if (this.source.type === 'smartrecruiters') {
      const jobs: RawJob[] = [];
      for (let offset = 0; offset < config.ATS_MAX_RESULTS_PER_SOURCE; offset += 100) {
        const limit = Math.min(100, config.ATS_MAX_RESULTS_PER_SOURCE - offset);
        const endpoint = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(this.source.companyId)}/postings?limit=${limit}&offset=${offset}`;
        const response = await fetchWithPolicy(endpoint, { sourceName: this.name, timeoutMs: config.SOURCE_TIMEOUT_MS, retries: config.SOURCE_RETRIES });
        const page = normalizeSmartRecruiters(await response.json(), this.source, now);
        jobs.push(...page);
        if (page.length < limit) break;
      }
      return jobs;
    }
    if (this.source.type === 'workday') {
      const workday = this.source;
      const jobs: RawJob[] = [];
      const endpoint = `${workday.host.replace(/\/$/, '')}/wday/cxs/${workday.tenant}/${workday.site}/jobs`;
      for (let offset = 0; offset < config.ATS_MAX_RESULTS_PER_SOURCE; offset += 100) {
        const limit = Math.min(100, config.ATS_MAX_RESULTS_PER_SOURCE - offset);
        const response = await fetchWithPolicy(endpoint, { sourceName: this.name, timeoutMs: config.SOURCE_TIMEOUT_MS, retries: config.SOURCE_RETRIES, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText: '' }) });
        const items = genericItems(await response.json());
        jobs.push(...items.map(item => {
          const externalPath = String(item.externalPath ?? '');
          const sourceUrl = externalPath ? `${workday.host.replace(/\/$/, '')}/en-US/${workday.site}${externalPath}` : endpoint;
          return { sourceName: this.name, sourceJobId: String(item.bulletFields?.[0] ?? item.id ?? externalPath), company: workday.company, title: String(item.title ?? ''), location: String(item.locationsText ?? 'Unspecified'), postedAt: item.postedOn, employmentType: item.timeType, sourceUrl, directApplyUrl: sourceUrl, scrapedAt: now, raw: item };
        }).filter(job => job.title));
        if (items.length < limit) break;
      }
      return jobs;
    }
    if (this.source.type === 'greenhouse') url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(this.source.board)}/jobs?content=false`;
    else if (this.source.type === 'ashby') url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(this.source.board)}?includeCompensation=true`;
    else { url = this.source.endpoint; init = { method: this.source.method ?? 'GET', headers: { 'content-type': 'application/json' }, body: this.source.body === undefined ? undefined : JSON.stringify(this.source.body) }; }
    const response = await fetchWithPolicy(url, { ...init, sourceName: this.name, timeoutMs: config.SOURCE_TIMEOUT_MS, retries: config.SOURCE_RETRIES });
    const payload: unknown = await response.json();
    if (this.source.type === 'greenhouse') return normalizeGreenhouse(payload, this.source, now).slice(0, config.ATS_MAX_RESULTS_PER_SOURCE);
    if (this.source.type === 'ashby') return normalizeAshby(payload, this.source, now).slice(0, config.ATS_MAX_RESULTS_PER_SOURCE);
    return genericItems(payload).slice(0, config.ATS_MAX_RESULTS_PER_SOURCE).map(item => ({
      sourceName: this.name, sourceJobId: String(item.id ?? item.jobId ?? item.requisitionId ?? item.externalPath ?? ''),
      company: this.source.company, title: String(item.title ?? item.jobTitle ?? item.name ?? ''),
      location: String(item.location ?? item.locationsText ?? item.primaryLocation ?? 'Unspecified'),
      postedAt: item.postedAt ?? item.postedOn ?? item.datePosted, description: item.description ?? item.jobDescription,
      employmentType: item.employmentType ?? item.timeType,
      sourceUrl: String(item.url ?? item.externalUrl ?? item.jobUrl ?? url), directApplyUrl: item.applyUrl ?? item.externalUrl ?? item.jobUrl,
      scrapedAt: now, raw: item
    })).filter(job => job.title);
  }
}

export async function loadAtsSources(): Promise<AtsSource[]> {
  const raw = JSON.parse(await readFile(resolve(projectRoot, 'config/sources.json'), 'utf8')) as { ats?: AtsConfig[] };
  return (raw.ats ?? []).map(source => new AtsSource(source));
}
