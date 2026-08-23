import { z } from 'zod';
import { STUDENT_ROLE } from '../classification.js';
import { activeProfile, config } from '../config.js';
import { fetchWithPolicy } from '../http.js';
import type { RawJob } from '../types.js';
import { SafeSource } from './base.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from '../config.js';

type AtsBoard =
  | { type: 'greenhouse'; board: string; company: string }
  | { type: 'lever'; site: string; company: string }
  | { type: 'ashby'; board: string; company: string }
  | { type: 'smartrecruiters'; companyId: string; company: string }
  | { type: 'workday'; host: string; tenant: string; site: string; company: string }
  | { type: 'oracle'; host: string; site: string; company: string }
  | { type: 'icims' | 'successfactors' | 'eightfold' | 'career-page'; company: string; endpoint: string; method?: 'GET' | 'POST'; body?: unknown };

// Which digest a board is fetched for. Absent means technical, which is what
// every board configured before the finance digest existed is. "both" is for
// the trading firms and the investment managers whose boards carry roles each
// reader wants: a quant internship belongs in either digest, and fetching the
// board twice is the only alternative.
export type AtsConfig = AtsBoard & { profile?: 'technical' | 'finance' | 'both' };

// nullish, not optional: Greenhouse sends first_published as an explicit null
// on a posting it has never published (a draft promoted in place, typically).
// z.string().optional() accepts a missing key but rejects null, and one such
// row failed the whole-board parse, so 79 Tower Research postings disappeared
// because two of them had no publication date.
const greenhouseSchema = z.object({ jobs: z.array(z.object({ id: z.union([z.string(), z.number()]), title: z.string(), absolute_url: z.string().url(), updated_at: z.string().nullish(), first_published: z.string().nullish(), location: z.object({ name: z.string() }), content: z.string().nullish() })) });
const leverSchema = z.array(z.object({ id: z.string(), text: z.string(), hostedUrl: z.string().url(), applyUrl: z.string().url().nullish(), createdAt: z.number().nullish(), categories: z.object({ location: z.string().nullish(), commitment: z.string().nullish() }).passthrough(), descriptionPlain: z.string().nullish() }));
const ashbySchema = z.object({ jobs: z.array(z.object({ id: z.string().nullish(), title: z.string(), location: z.string().nullish(), publishedAt: z.string().nullish(), jobUrl: z.string().url(), applyUrl: z.string().url().nullish(), descriptionPlain: z.string().nullish(), employmentType: z.string().nullish() })) });
const smartSchema = z.object({ content: z.array(z.object({ id: z.string(), name: z.string(), ref: z.string().url(), releasedDate: z.string().nullish(), location: z.object({ city: z.string().nullish(), region: z.string().nullish(), country: z.string().nullish() }).nullish() })), totalFound: z.number().nullish() });

/** Workday's own hard cap on `limit`; a larger page is an HTTP 400. */
const WORKDAY_PAGE_SIZE = 20;

const PACIFIC_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });

/**
 * Workday dates a posting in English prose: "Posted Today", "Posted Yesterday",
 * "Posted 5 Days Ago", "Posted 30+ Days Ago". That string used to be carried
 * through as `postedAt` verbatim, where `Date.parse` returned NaN, the age
 * bonus in `scoreJob` silently evaluated to nothing, and the digest printed
 * "Invalid Date" on the line that is supposed to say when the role went up.
 *
 * Resolved to midnight UTC rather than to the run's clock time: the phrase
 * names a day and nothing finer, and the digest renders a date-only value as a
 * date instead of inventing an hour for it. "30+" is a floor, so it is read as
 * exactly 30 days and the role sorts to the bottom either way.
 */
export function parseWorkdayPostedOn(value: unknown, now: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const reference = Date.parse(now);
  if (Number.isNaN(reference)) return undefined;
  const text = value.trim().toLowerCase().replace(/^posted\s+/, '');
  const relative = /^(\d+)\+?\s+days?\s+ago$/.exec(text);
  const days = /^today$/.test(text) ? 0 : /^yesterday$/.test(text) ? 1 : relative ? Number(relative[1]) : undefined;
  if (days === undefined) return undefined;
  // Which day "today" is, asked of the Pacific calendar rather than of UTC. A
  // run at 5pm Pacific is already tomorrow in UTC, so every role Workday called
  // "Posted Today" was dated a day into the future for the seven hours of the
  // day this digest is most often read.
  const today = Date.parse(`${PACIFIC_DAY.format(reference)}T00:00:00.000Z`);
  return new Date(today - days * 86_400_000).toISOString();
}

/** Keeps a value out of `postedAt` unless it is a date something can read. */
/** Eightfold's t_create/t_update, which are seconds rather than milliseconds. */
export function epochSecondsToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

// first_published, not updated_at. Greenhouse touches updated_at on any board
// edit, so IMC's July 1 internships were reported as posted two days ago and a
// six-week-old listing read as fresh. Fall back only when the field is absent.
/**
 * Greenhouse was fetched without descriptions, and all 93 boards answered with
 * none: 17,716 postings whose title was the only evidence there was. That is
 * why Epic's "Gameplay Programmer Intern" was dropped for having no cycle, and
 * with it 145 student roles a description would have dated.
 *
 * The board now answers with content, and the description is kept only where a
 * rule will read it. Anduril's board alone is 38 MB, so keeping all of it would
 * put roughly 300 MB through a run to classify about 500 student postings. A
 * non-student title whose body merely mentions an internship programme is lost
 * by this, which is no loss against a fetch that carried no body at all.
 */
/**
 * First publication, unless the board is recycling a requisition.
 *
 * first_published is the right field almost always: IMC's July internships
 * carried an updated_at of two days ago, so reading the edit date reported a
 * six-week-old listing as posted this week. But Databricks lists a Summer 2027
 * internship whose requisition was first published in August 2023 and edited
 * four days ago, and printing "Aug 17, 2023" against a 2027 role is not a date
 * the reader can use. Beyond a year and a half the first publication is
 * describing a different hiring round, so the edit date is the better of two
 * imperfect answers.
 */
const RECYCLED_AFTER_MS = 550 * 86_400_000;
export function greenhousePostedAt(firstPublished: string | null | undefined, updatedAt: string | null | undefined, now: string): string | undefined {
  const first = firstPublished ? Date.parse(firstPublished) : Number.NaN;
  const reference = Date.parse(now);
  if (!Number.isNaN(first) && !Number.isNaN(reference) && reference - first > RECYCLED_AFTER_MS && updatedAt) return updatedAt;
  return firstPublished ?? updatedAt ?? undefined;
}

export function normalizeGreenhouse(payload: unknown, cfg: Extract<AtsConfig, { type: 'greenhouse' }>, now: string): RawJob[] {
  return greenhouseSchema.parse(payload).jobs.map(job => ({ sourceName: `greenhouse:${cfg.board}`, sourceJobId: String(job.id), company: cfg.company, title: job.title, location: job.location.name, postedAt: greenhousePostedAt(job.first_published, job.updated_at, now), description: STUDENT_ROLE.test(job.title) ? job.content ?? undefined : undefined, sourceUrl: job.absolute_url, directApplyUrl: job.absolute_url, scrapedAt: now, employmentType: 'Internship' }));
}

export function normalizeLever(payload: unknown, cfg: Extract<AtsConfig, { type: 'lever' }>, now: string): RawJob[] {
  return leverSchema.parse(payload).map(job => ({ sourceName: `lever:${cfg.site}`, sourceJobId: job.id, company: cfg.company, title: job.text, location: job.categories.location ?? undefined, postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : undefined, description: job.descriptionPlain ?? undefined, employmentType: job.categories.commitment ?? undefined, sourceUrl: job.hostedUrl, directApplyUrl: job.applyUrl ?? job.hostedUrl, scrapedAt: now }));
}

export function normalizeAshby(payload: unknown, cfg: Extract<AtsConfig, { type: 'ashby' }>, now: string): RawJob[] {
  return ashbySchema.parse(payload).jobs.map(job => ({ sourceName: `ashby:${cfg.board}`, sourceJobId: job.id ?? undefined, company: cfg.company, title: job.title, location: job.location ?? undefined, postedAt: job.publishedAt ?? undefined, description: job.descriptionPlain ?? undefined, employmentType: job.employmentType ?? undefined, sourceUrl: job.jobUrl, directApplyUrl: job.applyUrl ?? job.jobUrl, scrapedAt: now }));
}

export function normalizeSmartRecruiters(payload: unknown, cfg: Extract<AtsConfig, { type: 'smartrecruiters' }>, now: string): RawJob[] {
  return smartSchema.parse(payload).content.map(job => ({ sourceName: `smartrecruiters:${cfg.companyId}`, sourceJobId: job.id, company: cfg.company, title: job.name, location: [job.location?.city, job.location?.region, job.location?.country].filter(Boolean).join(', ') || 'Unspecified', postedAt: job.releasedDate ?? undefined, sourceUrl: job.ref, directApplyUrl: job.ref, scrapedAt: now }));
}

// Oracle Recruiting buries the postings one level down, in the first element of
// items, beside the search metadata that produced them. The generic reader looks
// for a top-level array and finds `items` itself: one object, no title, dropped.
// American Express is an Oracle shop with 56 student postings, so this shape was
// the whole of its absence.
const oracleSchema = z.object({
  items: z.array(z.object({
    TotalJobsCount: z.number().nullish(),
    requisitionList: z.array(z.object({
      Id: z.union([z.string(), z.number()]),
      Title: z.string(),
      PrimaryLocation: z.string().nullish(),
      PostedDate: z.string().nullish(),
      ShortDescriptionStr: z.string().nullish(),
      ExternalQualificationsStr: z.string().nullish(),
      ExternalResponsibilitiesStr: z.string().nullish(),
      JobSchedule: z.string().nullish()
    }).loose()).nullish()
  }).loose())
});

export function normalizeOracle(payload: unknown, cfg: Extract<AtsConfig, { type: 'oracle' }>, now: string): RawJob[] {
  const host = cfg.host.replace(/\/$/, '');
  return (oracleSchema.parse(payload).items[0]?.requisitionList ?? []).map(job => {
    const url = `${host}/hcmUI/CandidateExperience/en/sites/${cfg.site}/job/${job.Id}`;
    return {
      // Must equal AtsSource.name: the pipeline attributes per-source counts by
      // matching the two, and a mismatch reports every board as 0 accepted.
      sourceName: `oracle:${normalizeSlug(cfg.company)}`, sourceJobId: String(job.Id), company: cfg.company,
      title: job.Title, location: job.PrimaryLocation ?? undefined,
      // Date only, no time, so it reads as midnight UTC rather than as invalid.
      postedAt: job.PostedDate ? new Date(`${job.PostedDate}T00:00:00Z`).toISOString() : undefined,
      // Three separate prose fields, and the sponsorship rules need all of them:
      // the citizenship sentence lives in qualifications far more often than in
      // the summary.
      description: [job.ShortDescriptionStr, job.ExternalResponsibilitiesStr, job.ExternalQualificationsStr].filter(Boolean).join('\n') || undefined,
      employmentType: job.JobSchedule ?? undefined,
      sourceUrl: url, directApplyUrl: url, scrapedAt: now
    };
  }).filter(job => job.title);
}

function normalizeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function genericItems(payload: unknown): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, any>;
  for (const key of ['jobs', 'jobPostings', 'items', 'results', 'positions', 'content']) if (Array.isArray(obj[key])) return obj[key];
  return [];
}

/** Eightfold's own page size: `num` is ignored and ten come back regardless. */
const EIGHTFOLD_PAGE_SIZE = 10;

// The shape-agnostic reader, for the families that are one endpoint returning
// one array. Field names vary by vendor, so each one is tried in turn.
function normalizeGeneric(item: any, source: AtsConfig, sourceName: string, now: string, fallbackUrl: string): RawJob {
  return {
    sourceName, sourceJobId: String(item.id ?? item.jobId ?? item.requisitionId ?? item.externalPath ?? ''),
    company: source.company, title: String(item.title ?? item.jobTitle ?? item.name ?? ''),
    location: String(item.location ?? item.locationsText ?? item.primaryLocation ?? 'Unspecified'),
    // Eightfold dates a posting in epoch seconds and links it as
    // canonicalPositionUrl. Without both, Millennium's campus board arrived
    // undated and pointing at the API endpoint rather than at the job.
    postedAt: isoOrUndefined(item.postedAt ?? item.datePosted) ?? parseWorkdayPostedOn(item.postedOn, now) ?? epochSecondsToIso(item.t_create ?? item.t_update),
    description: item.description ?? item.jobDescription ?? item.job_description,
    employmentType: item.employmentType ?? item.timeType,
    sourceUrl: String(item.url ?? item.externalUrl ?? item.jobUrl ?? item.canonicalPositionUrl ?? fallbackUrl),
    directApplyUrl: item.applyUrl ?? item.externalUrl ?? item.jobUrl ?? item.canonicalPositionUrl,
    scrapedAt: now, raw: item
  };
}

export class AtsSource extends SafeSource {
  readonly name: string;
  constructor(private readonly source: AtsConfig) {
    super();
    const identifier = source.type === 'greenhouse' ? source.board : source.type === 'lever' ? source.site : source.type === 'ashby' ? source.board : source.type === 'smartrecruiters' ? source.companyId : source.type === 'oracle' ? normalizeSlug(source.company) : source.company;
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
      const endpoint = `${workday.host.replace(/\/$/, '')}/wday/cxs/${workday.tenant}/${workday.site}/jobs`;
      // Twenty, and not a page more. Workday answers HTTP 400 with an empty
      // message for any limit above 20, so asking for a hundred failed every
      // board on every attempt: all ten investment managers reported FAILED on
      // the first run that configured one. Postings come back newest first, so
      // the per-source cap spends itself on the most recent week rather than on
      // an arbitrary slice.
      const sweep = async (searchText: string): Promise<RawJob[]> => {
        const found: RawJob[] = [];
        for (let offset = 0; offset < config.WORKDAY_MAX_RESULTS_PER_SOURCE; offset += WORKDAY_PAGE_SIZE) {
          const limit = Math.min(WORKDAY_PAGE_SIZE, config.WORKDAY_MAX_RESULTS_PER_SOURCE - offset);
          const response = await fetchWithPolicy(endpoint, { sourceName: this.name, timeoutMs: config.SOURCE_TIMEOUT_MS, retries: config.SOURCE_RETRIES, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText }) });
          const items = genericItems(await response.json());
          found.push(...items.map(item => {
            const externalPath = String(item.externalPath ?? '');
            const sourceUrl = externalPath ? `${workday.host.replace(/\/$/, '')}/en-US/${workday.site}${externalPath}` : endpoint;
            return { sourceName: this.name, sourceJobId: String(item.bulletFields?.[0] ?? item.id ?? externalPath), company: workday.company, title: String(item.title ?? ''), location: String(item.locationsText ?? 'Unspecified'), postedAt: parseWorkdayPostedOn(item.postedOn, now), employmentType: item.timeType, sourceUrl, directApplyUrl: sourceUrl, scrapedAt: now, raw: item };
          }).filter(job => job.title));
          if (items.length < limit) break;
        }
        return found.slice(0, config.WORKDAY_MAX_RESULTS_PER_SOURCE);
      };
      /**
       * The newest sixty postings, and then the same board asked for interns.
       *
       * A blank search returns the board newest-first, which on a small board is
       * everything and on a large one is a recency window. Sony publishes 102
       * postings of which 62 are internships, and Analog Devices publishes over
       * a thousand: their student roles sit outside the window and were
       * invisible however healthy the board looked in the logs. Workday ranks a
       * searched sweep by relevance instead of date, so asking for "intern"
       * surfaces exactly the postings the window hides. Measured across
       * fourteen boards it found 67 early-career roles beyond the 94 already
       * visible, 57 of them at Analog Devices alone.
       *
       * Merged on the requisition id, so a posting both sweeps return is one
       * row and the second sweep costs nothing on the boards small enough for
       * the first to have already read them.
       */
      const jobs = await sweep('');
      const seen = new Set(jobs.map(job => job.sourceJobId));
      for (const job of await sweep('intern')) if (!seen.has(job.sourceJobId)) { seen.add(job.sourceJobId); jobs.push(job); }
      return jobs;
    }
    if (this.source.type === 'oracle') {
      const oracle = this.source;
      const jobs: RawJob[] = [];
      for (let offset = 0; offset < config.ATS_MAX_RESULTS_PER_SOURCE; offset += 200) {
        const limit = Math.min(200, config.ATS_MAX_RESULTS_PER_SOURCE - offset);
        // The finder is one packed argument, so it has to be assembled rather
        // than passed as query parameters. expand is what carries the postings:
        // without it the response is the search metadata and no requisitions.
        const finder = `findReqs;siteNumber=${oracle.site},limit=${limit},offset=${offset},sortBy=POSTING_DATES_DESC`;
        const endpoint = `${oracle.host.replace(/\/$/, '')}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=${encodeURIComponent(finder)}`;
        const response = await fetchWithPolicy(endpoint, { sourceName: this.name, timeoutMs: config.SOURCE_TIMEOUT_MS, retries: config.SOURCE_RETRIES });
        const page = normalizeOracle(await response.json(), oracle, now);
        jobs.push(...page);
        if (page.length < limit) break;
      }
      return jobs;
    }
    // Eightfold answers with ten positions however many are asked for, so the
    // page size is fixed and the only way through the board is `start`.
    // Millennium publishes 59 campus roles and a single request sees six of
    // them; its 2027 quantitative internships are the reason this board is
    // configured at all.
    if (this.source.type === 'eightfold') {
      const jobs: RawJob[] = [];
      const base = this.source.endpoint;
      for (let start = 0; start < config.ATS_MAX_RESULTS_PER_SOURCE; start += EIGHTFOLD_PAGE_SIZE) {
        const paged = base.replace(/([?&])start=\d+/, `$1start=${start}`);
        const response = await fetchWithPolicy(paged === base && start ? `${base}&start=${start}` : paged, { sourceName: this.name, timeoutMs: config.SOURCE_TIMEOUT_MS, retries: config.SOURCE_RETRIES });
        const payload = await response.json() as { count?: number };
        const items = genericItems(payload);
        jobs.push(...items.map(item => normalizeGeneric(item, this.source, this.name, now, base)).filter(job => job.title));
        if (items.length < EIGHTFOLD_PAGE_SIZE || jobs.length >= (payload.count ?? 0)) break;
      }
      return jobs;
    }
    if (this.source.type === 'greenhouse') url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(this.source.board)}/jobs?content=${config.GREENHOUSE_CONTENT_ENABLED ? 'true' : 'false'}`;
    // No includeCompensation: nothing here reads a compensation field, and on
    // OpenAI's board asking for it costs 600 KB and about 1.5 seconds per run.
    else if (this.source.type === 'ashby') url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(this.source.board)}`;
    else { url = this.source.endpoint; init = { method: this.source.method ?? 'GET', headers: { 'content-type': 'application/json' }, body: this.source.body === undefined ? undefined : JSON.stringify(this.source.body) }; }
    const response = await fetchWithPolicy(url, { ...init, sourceName: this.name, timeoutMs: config.SOURCE_TIMEOUT_MS, retries: config.SOURCE_RETRIES });
    const payload: unknown = await response.json();
    // Greenhouse and Ashby answer with the whole board in one response, so the
    // paging cap is pure loss here: it discards postings already downloaded, in
    // an order that is not by date. Measured across 114 boards it was dropping
    // 52 of 223 internships, 31 of them from SpaceX alone. Bound generously to
    // stay sane on a huge board rather than to save bandwidth already spent.
    if (this.source.type === 'greenhouse') return normalizeGreenhouse(payload, this.source, now).slice(0, config.ATS_MAX_RESULTS_PER_BOARD);
    if (this.source.type === 'ashby') return normalizeAshby(payload, this.source, now).slice(0, config.ATS_MAX_RESULTS_PER_BOARD);
    return genericItems(payload).slice(0, config.ATS_MAX_RESULTS_PER_SOURCE)
      .map(item => normalizeGeneric(item, this.source, this.name, now, url)).filter(job => job.title);
  }
}

export async function loadAtsSources(): Promise<AtsSource[]> {
  const raw = JSON.parse(await readFile(resolve(projectRoot, 'config/sources.json'), 'utf8')) as { ats?: AtsConfig[] };
  // A board configured without a profile is a technical board, which is what
  // all 160 of them were before this line existed. The finance run fetches its
  // own boards and the shared ones, and none of the rest: the Greenhouse pass
  // alone is 300 MB, and the finance rules would reject every posting in it.
  return (raw.ats ?? [])
    .filter(source => source.profile === 'both' || (source.profile ?? 'technical') === activeProfile)
    .map(source => new AtsSource(source));
}
