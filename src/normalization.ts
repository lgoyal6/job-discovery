import { createHash } from 'node:crypto';

const trackingKeys = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gh_src', 'gh_jid', 'source', 'ref', 'referrer', 'trk', 'trackingid', 'lever-source',
  'lever-origin', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'
]);

export function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9+#.]+/g, ' ').trim();
}

export function canonicalizeUrl(input: string): string {
  try {
    const url = new URL(input.trim());
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (trackingKeys.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    // Ashby serves one posting at two paths, the listing and the same path with
    // /application on the end. Quadrillion's internship arrived once from its
    // own Ashby board and once from a list that linked the application form,
    // and with two spellings of the company ("Quadrillion" and "Quadrillion
    // Labs") the URL was the only key left that could see they were one job.
    url.pathname = url.pathname.replace(/\/application$/, '');
    const sorted = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    url.search = '';
    for (const [key, value] of sorted) url.searchParams.append(key, value);
    return url.toString();
  } catch {
    return input.trim();
  }
}

export function buildAliasMap(aliases: Record<string, string[]>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [canonical, values] of Object.entries(aliases)) {
    map.set(normalizeText(canonical), canonical);
    for (const alias of values) map.set(normalizeText(alias), canonical);
  }
  return map;
}

export function normalizeCompany(company: string, aliases: Map<string, string>): { normalized: string; display: string } {
  const normalized = normalizeText(company.replace(/\b(incorporated|inc|llc|ltd|corporation|corp|company|co)\.?$/i, ''));
  const display = aliases.get(normalized) ?? company.trim();
  return { normalized: normalizeText(display), display };
}

export function canonicalKey(input: {
  sourceName: string;
  sourceJobId?: string;
  canonicalUrl: string;
  normalizedCompany: string;
  normalizedTitle: string;
  normalizedLocation: string;
  cycle: string;
}): string {
  const meaningfulId = input.sourceJobId?.trim();
  const basis = meaningfulId
    ? `id:${normalizeText(input.sourceName)}:${meaningfulId}`
    : input.canonicalUrl.startsWith('http')
      ? `url:${input.canonicalUrl}`
      : `tuple:${input.normalizedCompany}|${input.normalizedTitle}|${input.normalizedLocation}|${input.cycle}`;
  return createHash('sha256').update(basis).digest('hex');
}

// One city, spelled by every list in its own way. Monster says "Atlanta, GA",
// Greenhouse and LinkedIn say "Atlanta, Georgia, United States", and the two
// used to be different locations to every comparison in this pipeline: a
// different normalized location, a different canonical key, a different
// material fingerprint. That is one of the ways the same role arrives twice.
const US_STATES: Record<string, string> = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co',
  connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id',
  illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la',
  maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn',
  mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv',
  'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny',
  'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or',
  pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd',
  tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa',
  'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy', 'district of columbia': 'dc'
};
const COUNTRY_WORDS = new Set(['united states', 'united states of america', 'usa', 'us', 'u s', 'u s a', 'america']);

function locationParts(value: string): string[] {
  return value.split(/[;,]/).map(part => normalizeText(part)).filter(Boolean)
    .filter(part => !COUNTRY_WORDS.has(part))
    .map(part => US_STATES[part] ?? part);
}

export function canonicalLocation(value: string): string {
  const parts = locationParts(value);
  // Everything was a country name; keep whatever was written rather than ''.
  return parts.length ? parts.join(' ') : normalizeText(value);
}

// One requisition open in several cities gets rendered differently by every
// list, "6 locations Atlanta, GA …", "Atlanta, GA +5", "New York, NY
// (multiple)", so those must share a bucket. Two postings each naming a single
// distinct city are genuinely separate roles and must not. The part count is
// taken after the country is dropped, so "Atlanta, Georgia, United States" is
// one city rather than a list of three places.
const MULTI_LOCATION = /\+\s*\d|\b\d+\s+locations?\b|\bmultiple\b|\bvarious\b/i;

export function locationBucket(location: string, normalizedLocation: string): string {
  if (MULTI_LOCATION.test(location)) return '*';
  const parts = locationParts(location);
  if (parts.length >= 3) return '*';
  return parts.length ? parts.join(' ') : normalizedLocation;
}

// Words that vary between lists describing the same requisition. Dropping them
// lets "SWE Intern - C++ or Python", "Software Engineering Internship - C++ or
// Python - Summer 2027" and "Software Engineering Intern (Summer 2027, C++ /
// Python)" collapse to one row instead of three.
const TITLE_NOISE = /^(intern|interns|internship|internships|co|op|coop|summer|fall|winter|spring|20\d\d|the|and|or|a|an|of|for|at|in|to|program|programme)$/;

// Truncation is what makes engineer/engineering agree. Five characters is short
// enough to stem those pairs and long enough that backend/frontend, undergrad/
// masters, and distinct team suffixes stay separate.
export function titleSignature(normalizedTitle: string): string {
  const tokens = normalizedTitle.split(/[^a-z0-9+#]+/)
    .filter(token => token && !TITLE_NOISE.test(token))
    .map(token => token.slice(0, 5));
  return [...new Set(tokens)].sort().join('.');
}

// What the digest already treats as one row: an employer's requisition for a
// cycle, whichever city it names and whichever list found it. Used to keep a
// requisition that has already been emailed from being emailed again under a
// second database row.
export function requisitionSignature(input: { normalizedCompany: string; normalizedTitle: string; cycle: string }): string | undefined {
  const signature = titleSignature(input.normalizedTitle);
  return signature ? `${input.normalizedCompany}|${input.cycle}|${signature}` : undefined;
}

// Title, location and cycle. Not the apply URL: a changed fingerprint clears
// sent_at and mails the role again, and the URL changes for reasons that are
// nothing to do with the role. Optiver's Chicago internship arrived twice two
// hours apart, once through LinkedIn and once through speedyapply, because the
// two lists link to it differently. Same requisition, same city, same cycle.
// A title, location or cycle change is what an applicant needs telling about.
//
// Both go in canonicalized, for the same reason the URL stays out. A second
// list writing "Atlanta, Georgia, United States" where the first wrote
// "Atlanta, GA", or "Software Engineer Intern, 2027" where the first wrote
// "2027 Software Engineer Intern", is not the role changing; it used to clear
// sent_at and mail the role again on the very next run.
export function materialFingerprint(input: { title: string; location: string; cycle: string }): string {
  return createHash('sha256').update([
    titleSignature(normalizeText(input.title)) || normalizeText(input.title),
    canonicalLocation(input.location), input.cycle
  ].join('|')).digest('hex');
}

/**
 * How much an apply URL is worth to somebody trying to apply.
 *
 * One requisition arrives from several sources, and they do not link to it
 * equally: a board links to the employer's own form, a community list links to
 * the same form, and intern-list links to its own write-up whose apply button
 * leads to an account wall. Dedupe kept whichever row scored highest, and score
 * knows nothing about links, so half the finance digest linked to a listing
 * while a row carrying the employer's form was discarded as the duplicate.
 */
const EMPLOYER_ATS = /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com|smartrecruiters\.com|icims\.com|workable\.com|jobvite\.com|taleo\.net|oraclecloud\.com|successfactors|avature\.net|phenompeople|eightfold\.ai|applytojob\.com|breezy\.hr|recruitee\.com|paylocity|dayforcehcm|ultipro|myworkday/i;
// A listing rather than an application: the row exists, but applying from it
// takes another search. dreamworkhq is here for the same reason jobright is:
// its list looks like the others and reads well, and every one of its 736 rows
// routes through a page on its own domain that asks the reader to sign in.
const LISTING_ONLY = /intern-list\.com|jobright\.ai|dreamworkhq\.com|simplify\.jobs\/c\/|github\.com|githubusercontent\.com/i;

export function applyLinkRank(url: string | undefined): number {
  if (!url || !url.startsWith('http')) return 0;
  if (LISTING_ONLY.test(url)) return 1;
  if (EMPLOYER_ATS.test(url)) return 3;
  return 2;
}

export function extractSourceJobId(url: string): string | undefined {
  const patterns = [
    /greenhouse\.io\/(?:[^/]+\/)?jobs\/(\d+)/i,
    /lever\.co\/[^/]+\/([a-f0-9-]{20,})/i,
    /ashbyhq\.com\/[^/]+\/([a-f0-9-]{16,})/i,
    /smartrecruiters\.com\/[^/]+\/(\d+-[^/?]+)/i,
    /(?:myworkdayjobs\.com|wd\d+\.myworkdaysite\.com)\/[^?#]*_((?:R|JR)[-_]?\d+(?:-\d+)?)(?:[/?]|$)/i,
    /linkedin\.com\/jobs\/view\/(\d+)/i,
    /[?&](?:jk|jobkey)=([a-z0-9]+)/i,
    /monster\.[^/]+\/job-openings\/[^/]*-([a-f0-9-]{8,})/i,
    /\/(?:jobs?|requisitions?)\/(\d{5,})(?:[/?]|$)/i
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}
