import { z } from 'zod';
import { activeProfile, config, type Profile } from '../config.js';
import { fetchWithPolicy } from '../http.js';
import type { RawJob, SourceResult } from '../types.js';
import { SafeSource, skippedSource } from './base.js';

const apifyItemSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(), jobId: z.union([z.string(), z.number()]).optional(), job_id: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(), jobTitle: z.string().optional(), positionName: z.string().optional(),
  company: z.union([z.string(), z.object({ name: z.string().optional() })]).optional(), companyName: z.string().optional(),
  location: z.union([z.string(), z.object({ name: z.string().optional() })]).optional(),
  description: z.string().optional(), descriptionText: z.string().optional(),
  url: z.string().optional(), jobUrl: z.string().optional(), link: z.string().optional(), sourceUrl: z.string().optional(),
  linkedinUrl: z.string().optional(),
  applyUrl: z.string().optional(), applicationUrl: z.string().optional(), directApplyUrl: z.string().optional(),
  postedAt: z.string().optional(), postedDate: z.string().optional(), datePosted: z.string().optional(),
  employmentType: z.union([z.string(), z.array(z.string())]).optional(),
  apply: z.object({ applyUrl: z.string().optional() }).optional(),
  jobPosting: z.object({
    title: z.string().optional(), description: z.string().optional(), datePosted: z.string().optional(), employmentType: z.union([z.string(), z.array(z.string())]).optional(),
    hiringOrganization: z.object({ name: z.string().optional() }).optional(),
    jobLocation: z.array(z.object({ address: z.object({ addressLocality: z.string().optional(), addressRegion: z.string().optional(), addressCountry: z.string().optional() }).optional() })).optional()
  }).optional()
}).passthrough();

export function normalizeApifyItems(payload: unknown[], board: string, now: string): RawJob[] {
  const jobs: RawJob[] = [];
  for (const raw of payload) {
    const parsed = apifyItemSchema.safeParse(raw);
    if (!parsed.success) continue;
    const item = parsed.data;
    const title = item.title ?? item.jobTitle ?? item.positionName ?? item.jobPosting?.title;
    const company = typeof item.company === 'string' ? item.company : item.company?.name ?? item.companyName ?? item.jobPosting?.hiringOrganization?.name;
    const sourceUrl = item.sourceUrl ?? item.linkedinUrl ?? item.jobUrl ?? item.url ?? item.link ?? item.apply?.applyUrl;
    if (!title || !company || !sourceUrl) continue;
    const employment = item.employmentType ?? item.jobPosting?.employmentType;
    jobs.push({ sourceName: board, sourceJobId: String(item.id ?? item.jobId ?? item.job_id ?? ''), title, company,
      location: typeof item.location === 'string' ? item.location : item.location?.name ?? item.jobPosting?.jobLocation?.map(value => [value.address?.addressLocality, value.address?.addressRegion, value.address?.addressCountry].filter(Boolean).join(', ')).filter(Boolean).join(' / '),
      postedAt: item.postedAt ?? item.postedDate ?? item.datePosted ?? item.jobPosting?.datePosted, description: item.descriptionText ?? item.description ?? item.jobPosting?.description,
      employmentType: Array.isArray(employment) ? employment.join(', ') : employment, sourceUrl, directApplyUrl: item.directApplyUrl ?? item.applicationUrl ?? item.applyUrl ?? item.apply?.applyUrl,
      scrapedAt: now, raw });
  }
  return jobs;
}

/**
 * What each digest asks a paid actor to search for.
 *
 * These strings were hardcoded to the technical digest, which is the other half
 * of why the finance profile could not use a paid source: even given a token, an
 * actor asked for "software engineering intern 2027" returns nothing the finance
 * rules accept, so every result would have been paid for and dropped.
 *
 * The wording matters more than the source does. Measured on Monster at 150
 * results a run, "finance internship summer 2027" returned 87 rows the finance
 * rules accept, 84 of them internships, none from a staffing agency, and 18
 * carrying a sponsorship policy the rules could read off the description.
 * "investment analyst intern 2027" returned four out of ten on the same actor
 * and the rest were senior FP&A roles. At a tenth of a cent per result, that
 * difference is the whole value of the source.
 */
const SEARCHES: Record<Profile, { primary: string; secondary: string }> = {
  technical: {
    primary: 'software engineering intern 2027',
    secondary: 'machine learning data engineering intern 2027'
  },
  finance: {
    primary: 'finance internship summer 2027',
    secondary: 'investment banking summer analyst internship 2027'
  }
};

export class ApifySource extends SafeSource {
  readonly name: string;
  constructor(private readonly board: 'linkedin' | 'indeed' | 'monster', private readonly actorId: string, private readonly maxResults: number, private readonly watchlistCompanies: string[] = []) { super(); this.name = `apify:${board}`; }
  override async fetch(): Promise<SourceResult> {
    if (!config.APIFY_ENABLED && !config.PAID_SOURCES_ENABLED) return skippedSource(this.name, 'Apify disabled; set APIFY_ENABLED=true to use free-plan credits');
    if (!config.APIFY_TOKEN) return skippedSource(this.name, 'APIFY_TOKEN is not configured');
    return super.fetch();
  }
  protected async collect(): Promise<RawJob[]> {
    if (!config.APIFY_TOKEN) return [];
    const { primary: query, secondary } = SEARCHES[activeProfile];
    const companyQueries = Array.from({ length: Math.ceil(this.watchlistCompanies.length / 5) }, (_, index) => this.watchlistCompanies.slice(index * 5, index * 5 + 5).join(' OR ')).filter(Boolean);
    const linkedinUrls = [query, ...companyQueries].slice(0, 8).map(keywords => `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(`${keywords} intern 2027`)}&location=United%20States&f_E=1&f_TPR=r86400`);
    const input = this.board === 'linkedin' ? {
      // Per source, and this actor is given eight of them, so passing the whole
      // budget here bought eight times it. Measured on the account: ten runs
      // returned 245 rows each and charged $0.49 each, $3.40 of a $5 monthly
      // credit, and `slice(0, maxResults)` below then kept 35 of those 245. The
      // other 210 were paid for and dropped on the floor. Divided across the
      // sources, the actor returns about what the cap keeps.
      urls: linkedinUrls,
      limitPerSource: Math.max(1, Math.ceil(this.maxResults / Math.max(1, linkedinUrls.length))),
      scrapeCompany: false
    } : this.board === 'indeed' ? {
      searches: [
        { query, location: 'United States', country: 'us', postedWithinDays: 1 },
        { query: secondary, location: 'United States', country: 'us', postedWithinDays: 1 }
      ],
      maxItems: this.maxResults,
      includeFullDescription: true
    } : {
      query, address: 'United States', country: 'US', radius: 100,
      maxPages: Math.max(1, Math.ceil(this.maxResults / 50)), pageSize: Math.min(50, this.maxResults), scrapeAllPages: false
    };
    const actor = this.actorId.replace('/', '~');
    const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(config.APIFY_TOKEN)}&timeout=${config.APIFY_ACTOR_TIMEOUT_SECONDS}&memory=512&maxTotalChargeUsd=${config.APIFY_MAX_TOTAL_CHARGE_USD}`;
    // run-sync blocks until the actor finishes, so the socket has to outlive the
    // actor's own budget or we abort a run that was about to succeed and pay for
    // it anyway. No retry: a re-run of a paid actor charges again for whatever
    // events it emits, and this runs once a day, so tomorrow is soon enough.
    const response = await fetchWithPolicy(endpoint, { sourceName: this.name, timeoutMs: (config.APIFY_ACTOR_TIMEOUT_SECONDS + 30) * 1000, retries: 0, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const payload = z.array(z.unknown()).parse(await response.json());
    // this.name, not this.board. Every other adapter stamps a job with the same
    // name its run reports under, and the pipeline attributes per-source counts
    // by matching the two. "monster" against a run called "apify:monster" never
    // matched, so all three Apify boards reported 0 accepted and 0 rejected even
    // on the run that delivered LPL Financial at the top of the digest.
    return normalizeApifyItems(payload.slice(0, this.maxResults), this.name, new Date().toISOString());
  }
}
