import { classifySponsorship, extractSkills } from './classification.js';
import { config, type SponsorshipPatterns } from './config.js';
import { log } from './logger.js';
import type { DigestJob, SponsorshipStatus } from './types.js';

export interface EnrichmentVerdict {
  jobId: string;
  status: SponsorshipStatus;
  evidence: string;
  sourceUrl: string;
  httpOk: boolean;
  // Harvested from the same text the verdict was read out of. Fetching the page
  // is the expensive part and it has already happened; throwing the prose away
  // afterwards is what left most of the digest saying "Not stated".
  skills: string[];
  summary: string;
}

// Community lists give a company, a title, a location and a link, no prose.
// The sponsorship rules need prose, so the posting's own page is the only place
// "U.S. citizens or permanent residents" can be found for these roles.
const SCRIPT_AND_STYLE = /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TAGS = /<[^>]+>/g;

export function extractText(html: string): string {
  return html
    .replace(SCRIPT_AND_STYLE, ' ')
    .replace(TAGS, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A Workday posting is a client-rendered shell: fetching it returns zero
 * characters of job text, which is why RTX's "U.S. citizenship is required"
 * never reached rules that already match that wording. Every tenant serves the
 * same posting as JSON from its CXS endpoint, description included.
 */
export function workdayJsonUrl(input: string): string | undefined {
  let url: URL;
  try { url = new URL(input); } catch { return undefined; }
  if (!/\.myworkdayjobs\.com$|\.myworkdaysite\.com$/i.test(url.hostname)) return undefined;
  if (url.pathname.startsWith('/wday/cxs/')) return undefined;
  const segments = url.pathname.split('/').filter(Boolean);
  const jobIndex = segments.indexOf('job');
  // Needs a site segment before /job/ and a posting path after it.
  if (jobIndex < 1 || jobIndex === segments.length - 1) return undefined;
  const tenant = url.hostname.split('.')[0];
  return `${url.origin}/wday/cxs/${tenant}/${segments[jobIndex - 1]}/${segments.slice(jobIndex).join('/')}`;
}

function workdayDescription(payload: unknown): string {
  const posting = (payload as { jobPostingInfo?: { jobDescription?: unknown } })?.jobPostingInfo;
  return typeof posting?.jobDescription === 'string' ? posting.jobDescription : '';
}

async function fetchOne(job: DigestJob, patterns: SponsorshipPatterns): Promise<EnrichmentVerdict> {
  const url = job.directApplyUrl || job.canonicalUrl || '';
  const base: EnrichmentVerdict = { jobId: job.id ?? '', status: 'UNKNOWN', evidence: '', sourceUrl: url, httpOk: false, skills: [], summary: '' };
  if (!url.startsWith('http')) return { ...base, evidence: 'No fetchable application URL.' };
  const jsonUrl = workdayJsonUrl(url);
  try {
    // No retries: this is best-effort enrichment behind a digest, and a slow
    // careers site must never extend the pipeline run.
    const response = await fetch(jsonUrl ?? url, {
      signal: AbortSignal.timeout(config.ENRICHMENT_TIMEOUT_MS),
      redirect: 'follow',
      headers: { 'user-agent': 'laksh-job-discovery/1.0 (+personal job search)', accept: jsonUrl ? 'application/json' : 'text/html,*/*' }
    });
    if (!response.ok) return { ...base, evidence: `HTTP ${response.status}` };
    const text = jsonUrl ? extractText(workdayDescription(await response.json())) : extractText(await response.text());
    // Some boards still render client-side, so a 200 can carry no job text.
    // Treat that as "asked and learned nothing", not as a verdict.
    if (text.length < 400) return { ...base, httpOk: true, evidence: `Page returned ${text.length} characters of text; nothing to classify.` };
    const verdict = classifySponsorship(`${job.title}\n${text}`, patterns);
    return {
      jobId: job.id ?? '', status: verdict.status, evidence: verdict.evidence, sourceUrl: url, httpOk: true,
      skills: extractSkills(`${job.title}\n${text}`),
      summary: text.slice(0, 280)
    };
  } catch (error) {
    return { ...base, evidence: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Fetches each posting and re-runs the sponsorship rules against its real text.
 * Never throws: enrichment is an improvement on the digest, not a precondition
 * for sending one.
 */
export async function enrichSponsorship(jobs: DigestJob[], patterns: SponsorshipPatterns): Promise<EnrichmentVerdict[]> {
  const targets = jobs.filter(job => job.id);
  const verdicts: EnrichmentVerdict[] = [];
  const queue = [...targets];
  const startedAt = Date.now();

  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      verdicts.push(await fetchOne(job, patterns));
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.ENRICHMENT_CONCURRENCY, targets.length) }, worker));

  const counts = verdicts.reduce<Record<string, number>>((acc, verdict) => {
    acc[verdict.status] = (acc[verdict.status] ?? 0) + 1;
    return acc;
  }, {});
  log('info', 'enrichment_complete', {
    attempted: targets.length,
    reachable: verdicts.filter(verdict => verdict.httpOk).length,
    durationMs: Date.now() - startedAt,
    ...counts
  });
  return verdicts;
}
