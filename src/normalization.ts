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

export function materialFingerprint(input: { title: string; location: string; cycle: string; directApplyUrl?: string }): string {
  return createHash('sha256').update([
    normalizeText(input.title), normalizeText(input.location), input.cycle,
    input.directApplyUrl ? canonicalizeUrl(input.directApplyUrl) : ''
  ].join('|')).digest('hex');
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
