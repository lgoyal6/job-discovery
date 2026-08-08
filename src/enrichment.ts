import { classifySponsorship } from './classification.js';
import { config, type SponsorshipPatterns } from './config.js';
import { log } from './logger.js';
import type { DigestJob, SponsorshipStatus } from './types.js';

export interface EnrichmentVerdict {
  jobId: string;
  status: SponsorshipStatus;
  evidence: string;
  sourceUrl: string;
  httpOk: boolean;
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

async function fetchOne(job: DigestJob, patterns: SponsorshipPatterns): Promise<EnrichmentVerdict> {
  const url = job.directApplyUrl || job.canonicalUrl || '';
  const base: EnrichmentVerdict = { jobId: job.id ?? '', status: 'UNKNOWN', evidence: '', sourceUrl: url, httpOk: false };
  if (!url.startsWith('http')) return { ...base, evidence: 'No fetchable application URL.' };
  try {
    // No retries: this is best-effort enrichment behind a digest, and a slow
    // careers site must never extend the pipeline run.
    const response = await fetch(url, {
      signal: AbortSignal.timeout(config.ENRICHMENT_TIMEOUT_MS),
      redirect: 'follow',
      headers: { 'user-agent': 'laksh-job-discovery/1.0 (+personal job search)', accept: 'text/html,*/*' }
    });
    if (!response.ok) return { ...base, evidence: `HTTP ${response.status}` };
    const text = extractText(await response.text());
    // Workday and similar render client-side, so a 200 can still carry no job
    // text. Treat that as "asked and learned nothing", not as a verdict.
    if (text.length < 400) return { ...base, httpOk: true, evidence: `Page returned ${text.length} characters of text; nothing to classify.` };
    const verdict = classifySponsorship(`${job.title}\n${text}`, patterns);
    return { jobId: job.id ?? '', status: verdict.status, evidence: verdict.evidence, sourceUrl: url, httpOk: true };
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
