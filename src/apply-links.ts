import { config } from './config.js';
import { log } from './logger.js';
import { guardedFetch } from './net-guard.js';
import { applyLinkRank, normalizeText } from './normalization.js';
import { paced } from './sources/linkedin.js';
import type { DigestJob } from './types.js';

/**
 * Finds a real posting for a row whose only link is a write-up of the role.
 *
 * intern-list carries roles nothing else on this pipeline carries, JPMorgan's
 * equity research internship and William Blair's private wealth programme among
 * them, so dropping the source would cost the digest rows it cannot replace.
 * But its page is the site's own summary and its apply button leads to a
 * jobright.ai account wall, so half the finance digest was reaching a write-up
 * instead of an application form.
 *
 * LinkedIn's guest search is asked for the same role by title and employer, and
 * its posting URL is one anybody can open and apply through. Only the digest's
 * own rows are resolved, one per requisition after the cap, which is about
 * twenty-six requests rather than the sixty the source produces.
 *
 * The identity of the row does not move. canonicalUrl, the canonical key and
 * the material fingerprint are all computed before this runs and none of them
 * reads the apply link, so a resolved row is the same row to dedupe, to the
 * send state, and to the ledger. Only the link the reader clicks changes.
 */
const GUEST_SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

// Words every internship title contains, which therefore say nothing about
// which internship this is.
const FILLER = /^(intern|interns|internship|internships|co|op|coop|summer|fall|winter|spring|20\d\d|program|programme|the|and|or|a|an|of|for|at|in|to|new|grad|graduate|student|campus|university|undergrad|undergraduate|masters|phd)$/;
const EARLY = /intern|co-?op|summer analyst|summer associate|campus|graduate program/i;

function identityWords(title: string): Set<string> {
  return new Set(normalizeText(title).split(' ').filter(word => word.length > 2 && !FILLER.test(word)));
}

function sameEmployer(a: string, b: string): boolean {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return false;
  return left === right || (left.length > 2 && right.length > 2 && (left.includes(right) || right.includes(left)));
}

/**
 * Deliberately strict, because the failure modes are not symmetric.
 *
 * A loose threshold resolved two thirds of these rows and sent one in four to
 * the wrong requisition: Allegiant's "Intern, Financial Analyst" matched a
 * "Sr Analyst, Office of the CEO" posting. A link to the wrong job is worse
 * than a link to a write-up of the right one, because the reader cannot tell
 * from the digest that it is wrong. So this resolves fewer and is right about
 * the ones it does.
 */
export function describesSameRole(candidate: string, target: string): boolean {
  if (EARLY.test(candidate) !== EARLY.test(target)) return false;
  const left = identityWords(candidate);
  const right = identityWords(target);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size) >= 0.7;
}

function parseCards(html: string): Array<{ title: string; company: string; url: string }> {
  const clean = (value: string): string => value.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
  return html.split(/<li>/).slice(1).map(card => ({
    title: clean(card.match(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? ''),
    company: clean(card.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/)?.[1] ?? ''),
    // Strip the per-impression tracking, so the link is the posting and nothing else.
    url: (card.match(/base-card__full-link[^>]*href="([^"]+)"/)?.[1] ?? '').split('?')[0] ?? ''
  })).filter(card => card.title && card.company && card.url);
}

/**
 * A Workday posting addressed by the slug zapplyjobs' redirector leaves behind.
 *
 * community.ts rebuilds the boards whose URL is a function of that slug.
 * Workday's is not: the slug names the tenant, the career site and the
 * requisition, and the host carries a data-centre number (nvidia.wd5, bah.wd1,
 * td.wd3) the slug never had. It also writes the site in lower case with its
 * underscores turned to hyphens, bah-jobs for BAH_Jobs, and Workday ignores the
 * case but not the punctuation. The site's search API answers a requisition
 * number with the posting's own path, and a wrong host or site answers 422 or
 * 404 at once, so the numbers are tried in order of how often they occur until
 * one answers, and the answer is kept for the tenant's other rows.
 */
const WORKDAY_HOSTS = [1, 5, 3, 12, 103, 108, 501];
// Case-sensitive on purpose: the slug lowercases the tenant and site but keeps
// the requisition as written, so an upper-case prefix is the only way to tell
// "external-181764" (a site, then a number) from "R-10064679" (one requisition).
// A requisition may carry a second number group, REQ-2026-18071 or R26-01519;
// none of the list's sites ends in a digit, so the number after a site is the
// requisition's and not the site's.
const ZAPPLY_WORKDAY = /^https?:\/\/zapply\.jobs\/l\/d\/workday-([^-]+)-(.+?)-((?:[A-Z]{1,4}[-_]?)?\d+(?:-\d+)?)(?:[/?#].*)?$/;

export interface WorkdaySlug { tenant: string; site: string; requisition: string }
interface WorkdaySite { host: number; site: string }
interface WorkdayAnswer { reached: boolean; url?: string }

export function parseZapplyWorkday(url: string | undefined): WorkdaySlug | undefined {
  const match = url ? ZAPPLY_WORKDAY.exec(url) : null;
  return match ? { tenant: match[1] ?? '', site: match[2] ?? '', requisition: match[3] ?? '' } : undefined;
}

async function searchWorkday(tenant: string, at: WorkdaySite, requisition: string): Promise<WorkdayAnswer> {
  const base = `https://${tenant}.wd${at.host}.myworkdayjobs.com`;
  const response = await guardedFetch(`${base}/wday/cxs/${tenant}/${at.site}/jobs`, {
    method: 'POST',
    signal: AbortSignal.timeout(config.ENRICHMENT_TIMEOUT_MS),
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: requisition })
  });
  if (!response.ok) return { reached: false };
  const payload = await response.json() as { jobPostings?: Array<{ externalPath?: string }> };
  // The path ends in the requisition, sometimes with a posting number after it:
  // _JR37468-2 for the second posting of JR37468. The requisition is letters,
  // digits, - and _ by construction, so it needs no escaping.
  const ends = new RegExp(`_${requisition}(?:-\\d+)?$`, 'i');
  const posting = payload.jobPostings?.find(candidate => ends.test(candidate.externalPath ?? ''));
  return { reached: true, url: posting?.externalPath ? `${base}/${at.site}${posting.externalPath}` : undefined };
}

async function resolveWorkday(slug: WorkdaySlug, known: Map<string, WorkdaySite | null>): Promise<string | undefined> {
  const key = `${slug.tenant}/${slug.site}`;
  const hit = known.get(key);
  if (hit === null) return undefined;
  const spellings = [...new Set([slug.site.replace(/-/g, '_'), slug.site])];
  const candidates = hit ? [hit] : WORKDAY_HOSTS.flatMap(host => spellings.map(site => ({ host, site })));
  for (const candidate of candidates) {
    const answer = await searchWorkday(slug.tenant, candidate, slug.requisition).catch((): WorkdayAnswer => ({ reached: false }));
    if (!answer.reached) continue;
    known.set(key, candidate);
    return answer.url;
  }
  if (!hit) known.set(key, null);
  return undefined;
}

async function resolveOne(job: DigestJob, workday: Map<string, WorkdaySite | null>): Promise<string | undefined> {
  const slug = parseZapplyWorkday(job.directApplyUrl ?? job.canonicalUrl);
  if (slug) {
    const posting = await resolveWorkday(slug, workday);
    if (posting) return posting;
  }
  const query = `${job.title} ${job.company}`.slice(0, 120);
  const url = `${GUEST_SEARCH}?keywords=${encodeURIComponent(query)}&location=${encodeURIComponent('United States')}&start=0`;
  try {
    const response = await paced(() => guardedFetch(url, {
      signal: AbortSignal.timeout(config.ENRICHMENT_TIMEOUT_MS),
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' }
    }));
    if (!response.ok) return undefined;
    const match = parseCards(await response.text())
      .find(card => sameEmployer(card.company, job.company) && describesSameRole(card.title, job.title));
    return match?.url;
  } catch {
    return undefined;
  }
}

/**
 * Replaces the apply link on every digest row that has only a listing. Mutates
 * the rows in place and never throws: a better link is an improvement on the
 * digest, not a precondition for sending one.
 */
export async function resolveListingLinks(jobs: DigestJob[]): Promise<{ attempted: number; resolved: number }> {
  if (!config.APPLY_LINK_RESOLUTION_ENABLED) return { attempted: 0, resolved: 0 };
  const listings = jobs
    .filter(job => applyLinkRank(job.directApplyUrl ?? job.canonicalUrl) === 1)
    .slice(0, config.APPLY_LINK_RESOLUTION_MAX);
  let resolved = 0;
  const workday = new Map<string, WorkdaySite | null>();
  for (const job of listings) {
    const found = await resolveOne(job, workday);
    if (!found) continue;
    job.directApplyUrl = found;
    resolved += 1;
  }
  if (listings.length) log('info', 'apply_links_resolved', { attempted: listings.length, resolved });
  return { attempted: listings.length, resolved };
}
