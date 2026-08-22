import { config } from './config.js';
import { log } from './logger.js';
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

async function resolveOne(job: DigestJob): Promise<string | undefined> {
  const query = `${job.title} ${job.company}`.slice(0, 120);
  const url = `${GUEST_SEARCH}?keywords=${encodeURIComponent(query)}&location=${encodeURIComponent('United States')}&start=0`;
  try {
    const response = await paced(() => fetch(url, {
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
  for (const job of listings) {
    const found = await resolveOne(job);
    if (!found) continue;
    job.directApplyUrl = found;
    resolved += 1;
  }
  if (listings.length) log('info', 'apply_links_resolved', { attempted: listings.length, resolved });
  return { attempted: listings.length, resolved };
}
