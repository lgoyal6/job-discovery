import { z } from 'zod';
import { config } from './config.js';
import { fetchWithPolicy } from './http.js';
import { canonicalizeUrl, normalizeText } from './normalization.js';
import type { NotionExclusionKind, NotionMatchBasis } from './types.js';

export interface LedgerExclusion {
  notionPageId: string;
  companyNormalized: string;
  titleNormalized: string;
  canonicalUrl?: string;
  sourceJobId?: string;
  titleJobId?: string;
  kind: NotionExclusionKind;
}

const querySchema = z.object({ results: z.array(z.object({ id: z.string(), properties: z.record(z.string(), z.any()) })), has_more: z.boolean(), next_cursor: z.string().nullable().optional() });

// One list, used by both directions. A row this pipeline writes has to be a row
// this pipeline can read back as an exclusion, and the reader finds a field by
// these names, so writing under any other name files a page that never excludes
// anything.
export const LEDGER_FIELDS = {
  company: ['Company', 'Employer'],
  title: ['Role', 'Title', 'Name'],
  url: ['Link', 'URL', 'Application URL'],
  sourceJobId: ['Job ID', 'Source Job ID'],
  status: ['Status'],
  purge: ['Purge'],
  // The ledger already had a column for each of these, and its select options
  // are this pipeline's own vocabulary: Category is exactly SWE/ML-AI/Quant/
  // GTM Eng/Other, Cycle is the four target cycles, and all 15 skills the
  // extractor can name are already options. A row that fills only company,
  // role and link leaves a tracker that has to be finished by hand.
  location: ['Location'],
  cycle: ['Cycle'],
  category: ['Category'],
  workAuth: ['Work Auth', 'Work Authorization', 'Sponsorship Status'],
  skills: ['Required Skills', 'Skills'],
  postedAt: ['Original Posted Date', 'Posted Date', 'Posted'],
  summary: ['JD Meta', 'Summary', 'Notes'],
  appliedOn: ['Date Applied', 'Applied Date', 'Applied On']
} as const;

const APPLIED_STATUSES = ['Applied', 'In Review', 'Interview', 'Offer', 'Rejected'] as const;
const INELIGIBLE_STATUS = 'Ineligible';
const LEGACY_INELIGIBLE_PURGE = 'Ineligible - delete';
const DUPLICATE_PURGE = 'Duplicate - delete';

function exclusionFilter(): Record<string, unknown> {
  return {
    or: [
      ...APPLIED_STATUSES.map(value => ({ property: LEDGER_FIELDS.status[0], select: { equals: value } })),
      { property: LEDGER_FIELDS.status[0], select: { equals: INELIGIBLE_STATUS } },
      { property: LEDGER_FIELDS.purge[0], select: { equals: LEGACY_INELIGIBLE_PURGE } },
      { property: LEDGER_FIELDS.purge[0], select: { equals: DUPLICATE_PURGE } }
    ]
  };
}

// The ledger's own words for a sponsorship verdict.
const WORK_AUTH: Record<string, string> = { SUPPORTED: 'F-1 OK', UNSUPPORTED: 'US only', UNKNOWN: 'Unknown' };

function propertyText(property: any): string {
  if (!property) return '';
  if (property.type === 'title') return (property.title ?? []).map((item: any) => item.plain_text ?? '').join('');
  if (property.type === 'rich_text') return (property.rich_text ?? []).map((item: any) => item.plain_text ?? '').join('');
  if (property.type === 'select') return property.select?.name ?? '';
  if (property.type === 'status') return property.status?.name ?? '';
  if (property.type === 'url') return property.url ?? '';
  return '';
}

function findProperty(properties: Record<string, any>, names: readonly string[]): [string, any] | undefined {
  for (const name of names) {
    const entry = Object.entries(properties).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (entry) return entry;
  }
  return undefined;
}

function named(properties: Record<string, any>, names: readonly string[]): string {
  const entry = findProperty(properties, names);
  return entry ? propertyText(entry[1]) : '';
}

export async function readLedgerExclusions(): Promise<LedgerExclusion[]> {
  if (!config.NOTION_TOKEN) return [];
  const exclusions: LedgerExclusion[] = [];
  let cursor: string | undefined;
  let useLegacyDatabaseQuery = false;
  do {
    // Status and Purge are both select properties. A role the user has already
    // decided on must not resurface just because the decision was not Applied.
    const body = JSON.stringify({ page_size: 100, filter: exclusionFilter(), ...(cursor ? { start_cursor: cursor } : {}) });
    let response: Response;
    try {
      response = await fetchWithPolicy(useLegacyDatabaseQuery
        ? `https://api.notion.com/v1/databases/${config.NOTION_DATABASE_ID}/query`
        : `https://api.notion.com/v1/data_sources/${config.NOTION_DATA_SOURCE_ID}/query`, {
        sourceName: 'notion-applied', timeoutMs: config.SOURCE_TIMEOUT_MS, retries: config.SOURCE_RETRIES,
        method: 'POST', headers: {
          authorization: `Bearer ${config.NOTION_TOKEN}`,
          'notion-version': useLegacyDatabaseQuery ? '2022-06-28' : '2025-09-03',
          'content-type': 'application/json'
        }, body
      });
    } catch (error) {
      // Some workspaces expose the data source in search/metadata but have not
      // propagated query access yet. The legacy database query is read-only and
      // remains supported, so use it as a compatibility fallback on 404 only.
      if (!useLegacyDatabaseQuery && config.NOTION_DATABASE_ID && String(error).includes('HTTP 404')) {
        useLegacyDatabaseQuery = true;
        response = await fetchWithPolicy(`https://api.notion.com/v1/databases/${config.NOTION_DATABASE_ID}/query`, {
          sourceName: 'notion-applied', timeoutMs: config.SOURCE_TIMEOUT_MS, retries: config.SOURCE_RETRIES,
          method: 'POST', headers: { authorization: `Bearer ${config.NOTION_TOKEN}`, 'notion-version': '2022-06-28', 'content-type': 'application/json' }, body
        });
      } else throw error;
    }
    const page = querySchema.parse(await response.json());
    for (const row of page.results) {
      const company = named(row.properties, LEDGER_FIELDS.company);
      const { title, jobId: titleJobId } = splitTitleRequisition(named(row.properties, LEDGER_FIELDS.title));
      const link = named(row.properties, LEDGER_FIELDS.url);
      const sourceJobId = named(row.properties, LEDGER_FIELDS.sourceJobId);
      const status = named(row.properties, LEDGER_FIELDS.status);
      const purge = named(row.properties, LEDGER_FIELDS.purge);
      const kind = APPLIED_STATUSES.some(value => value.toLowerCase() === status.toLowerCase())
        ? 'APPLIED'
        : status.toLowerCase() === INELIGIBLE_STATUS.toLowerCase() || purge.toLowerCase() === LEGACY_INELIGIBLE_PURGE.toLowerCase()
          ? 'INELIGIBLE'
          : purge.toLowerCase() === DUPLICATE_PURGE.toLowerCase()
            ? 'DUPLICATE'
            : undefined;
      if (company && title && kind) exclusions.push({
        notionPageId: row.id,
        companyNormalized: normalizeText(company),
        titleNormalized: normalizeText(title),
        canonicalUrl: link ? canonicalizeUrl(link) : undefined,
        sourceJobId: sourceJobId || undefined,
        titleJobId,
        kind
      });
    }
    cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
  } while (cursor);
  return exclusions;
}

export interface AppliedLedgerEntry {
  company: string; title: string; url?: string; sourceJobId?: string;
  location?: string; cycle?: string; category?: string; sponsorshipStatus?: string;
  skills?: string[]; postedAt?: string; summary?: string;
}

const schemaSchema = z.object({ properties: z.record(z.string(), z.object({ type: z.string() }).loose()) });

interface LedgerBinding { version: string; parent: Record<string, string>; schema: Record<string, { type: string }> }
let cachedBinding: Promise<LedgerBinding> | undefined;

function notionCall(url: string, version: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithPolicy(url, {
    sourceName: 'notion-write', timeoutMs: config.SOURCE_TIMEOUT_MS, retries: 0,
    headers: { authorization: `Bearer ${config.NOTION_TOKEN}`, 'notion-version': version, 'content-type': 'application/json' },
    ...init
  });
}

/**
 * The ledger's shape, read once per process.
 *
 * The ledger's own schema decides the payload rather than a guess, because the
 * column that carries a role differs per workspace - in this one Company holds
 * the page title and Role is rich text, so a payload built from Notion's types
 * alone would file the company name as the role. Mirroring a run's postings is
 * many writes and not one of them needs to ask for this again.
 */
async function ledgerBinding(): Promise<LedgerBinding> {
  if (!config.NOTION_TOKEN) throw new Error('NOTION_TOKEN is not set.');
  // Same fallback the read path earned: a workspace can expose the data source
  // for metadata while the newer API still answers 404 for it.
  cachedBinding ??= (async (): Promise<LedgerBinding> => {
    try {
      const response = await notionCall(`https://api.notion.com/v1/data_sources/${config.NOTION_DATA_SOURCE_ID}`, '2025-09-03');
      return { version: '2025-09-03', parent: { type: 'data_source_id', data_source_id: config.NOTION_DATA_SOURCE_ID }, schema: schemaSchema.parse(await response.json()).properties };
    } catch (error) {
      if (!config.NOTION_DATABASE_ID || !String(error).includes('HTTP 404')) throw error;
      const response = await notionCall(`https://api.notion.com/v1/databases/${config.NOTION_DATABASE_ID}`, '2022-06-28');
      return { version: '2022-06-28', parent: { database_id: config.NOTION_DATABASE_ID }, schema: schemaSchema.parse(await response.json()).properties };
    }
  })().catch((error: unknown) => { cachedBinding = undefined; throw error; });
  return cachedBinding;
}

/**
 * Files one role in the ledger under the given status.
 *
 * 'Applied' is what the exclusion read filters on, so a page written under any
 * other status is a record rather than an exclusion. That is what lets the
 * mirror fill the ledger with postings without one of them reading as applied.
 */
export async function createLedgerPage(entry: AppliedLedgerEntry, status: string): Promise<string> {
  const { version, parent, schema } = await ledgerBinding();
  const properties = buildProperties(schema, [
    [LEDGER_FIELDS.company, entry.company],
    [LEDGER_FIELDS.title, entry.title],
    [LEDGER_FIELDS.url, entry.url ?? ''],
    [LEDGER_FIELDS.sourceJobId, entry.sourceJobId ?? ''],
    [LEDGER_FIELDS.status, status],
    [LEDGER_FIELDS.location, entry.location ?? ''],
    [LEDGER_FIELDS.cycle, entry.cycle ?? ''],
    [LEDGER_FIELDS.category, entry.category ?? ''],
    [LEDGER_FIELDS.workAuth, entry.sponsorshipStatus ? WORK_AUTH[entry.sponsorshipStatus] ?? '' : ''],
    [LEDGER_FIELDS.skills, entry.skills ?? []],
    // A date column rejects a timestamp's time half, and one malformed value
    // fails the whole page rather than the one property.
    [LEDGER_FIELDS.postedAt, entry.postedAt ? entry.postedAt.slice(0, 10) : ''],
    [LEDGER_FIELDS.summary, entry.summary ?? '']
  ]);
  const statusProperty = findProperty(schema, LEDGER_FIELDS.status);
  if (!statusProperty || !(statusProperty[0] in properties)) {
    throw new Error(`The ledger has no Status option that can carry "${status}".`);
  }
  const created = await notionCall('https://api.notion.com/v1/pages', version, {
    method: 'POST', body: JSON.stringify({ parent, properties })
  });
  return z.object({ id: z.string() }).parse(await created.json()).id;
}

/**
 * Moves a page the mirror already wrote to a new status, so marking a role
 * applied updates its row rather than filing a second one beside it.
 */
export async function setLedgerStatus(pageId: string, status: string, appliedOn?: string): Promise<void> {
  const { version, schema } = await ledgerBinding();
  const statusProperty = findProperty(schema, LEDGER_FIELDS.status);
  const properties = buildProperties(schema, [
    [LEDGER_FIELDS.status, status],
    // The ledger has a column for the day of the application, and the click
    // that files it is the only moment that knows.
    [LEDGER_FIELDS.appliedOn, appliedOn ?? '']
  ]);
  if (!statusProperty || !(statusProperty[0] in properties)) {
    throw new Error(`The ledger has no Status option that can carry "${status}".`);
  }
  if (status === 'Applied' || status === 'Ineligible') {
    const purge = findProperty(schema, LEDGER_FIELDS.purge);
    if (purge) properties[purge[0]] = clearProperty(purge[1] as { type: string });
  }
  if (status === 'Ineligible') {
    const appliedDate = findProperty(schema, LEDGER_FIELDS.appliedOn);
    if (appliedDate) properties[appliedDate[0]] = clearProperty(appliedDate[1] as { type: string });
  }
  await notionCall(`https://api.notion.com/v1/pages/${pageId}`, version, {
    method: 'PATCH', body: JSON.stringify({ properties })
  });
}

function clearProperty(definition: { type: string }): unknown {
  if (definition.type === 'select') return { select: null };
  if (definition.type === 'status') return { status: null };
  if (definition.type === 'date') return { date: null };
  return undefined;
}

function buildProperties(schema: Record<string, { type: string }>, values: Array<[readonly string[], string | string[]]>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [names, value] of values) {
    if (!value.length) continue;
    const found = findProperty(schema, names);
    if (!found) continue;
    const encoded = encodeProperty(found[1] as { type: string }, value);
    if (encoded) properties[found[0]] = encoded;
  }
  return properties;
}

/**
 * Encodes one value for one column, from that column's own definition.
 *
 * A select is written only when the option already exists. Notion invents an
 * option for anything it has not seen, so writing a cycle of "Later compatible"
 * into a Cycle column offering the four target cycles would quietly add a fifth
 * to a database this pipeline does not own.
 */
function encodeProperty(definition: { type: string; [key: string]: unknown }, value: string | string[]): unknown {
  const type = definition.type;
  const options = (definition[type] as { options?: Array<{ name: string }> } | undefined)?.options;
  const known = (name: string): boolean => !options || options.some(option => option.name.toLowerCase() === name.toLowerCase());

  if (Array.isArray(value)) {
    if (type !== 'multi_select') return undefined;
    const names = value.filter(known).map(name => ({ name }));
    return names.length ? { multi_select: names } : undefined;
  }
  const text = [{ type: 'text', text: { content: value.slice(0, 2000) } }];
  if (type === 'title') return { title: text };
  if (type === 'rich_text') return { rich_text: text };
  if (type === 'url') return { url: value };
  if (type === 'date') return { date: { start: value } };
  if (type === 'select') return known(value) ? { select: { name: value } } : undefined;
  if (type === 'status') return known(value) ? { status: { name: value } } : undefined;
  return undefined;
}

// Words that carry no identity, so that a title differing only in these still
// matches the row filed against it.
const FILLER = /^(intern|interns|internship|internships|co|op|coop|summer|fall|winter|spring|20\d\d|program|programme|the|and|or|a|an|of|for|at|in|to|new|grad|graduate|student|campus|university|undergrad|undergraduate|masters|phd)$/;

// American Express writes the requisition into the role text - "Campus
// Undergraduate Summer Internship 2027 - Software Engineer, Technology (Job
// 26010970)" - because the tracker has no Job ID column to put it in. Left
// there it is worse than useless: "job" and the number both survive the filler
// filter below, so they count as identity words, and the applied row scored
// 0.75 against the board's own wording where the threshold is 0.80. The role
// was filed as applied and arrived in the digest anyway, twice a day.
const TITLE_REQUISITION = /\(\s*(?:job|req|requisition|posting)\s*(?:id|no\.?|#)?\s*[:#-]?\s*([a-z0-9][a-z0-9-]{3,})\s*\)/i;

/** Separates a trailing "(Job 26010970)" from the role it was written into. */
export function splitTitleRequisition(title: string): { title: string; jobId?: string } {
  const match = TITLE_REQUISITION.exec(title);
  if (!match) return { title };
  return { title: title.replace(match[0], ' ').replace(/\s{2,}/g, ' ').trim(), jobId: match[1] };
}

function identityWords(title: string): Set<string> {
  return new Set(title.split(' ').filter(word => word.length > 2 && !FILLER.test(word)));
}

/**
 * Whether a role is one this reader has already applied to.
 *
 * Exact title equality was the only test that ever fired, and a Notion row is
 * almost never worded exactly as a board words it. The ledger says "Campus
 * Undergraduate Summer Internship 2027 Software" where American Express posts
 * "Campus Undergraduate Summer Internship Program - 2027 Software Engineer",
 * so the row was filed, the role was excluded from nothing, and it arrived
 * again in the next digest and the one after that.
 *
 * So the titles are compared on the words that carry identity, ignoring the
 * ones every internship title contains. The threshold is deliberately high and
 * measured against the smaller of the two sets, so "Software Engineer Intern,
 * Search" matches the ledger's "Software Engineer Intern" while NVIDIA's "Deep
 * Learning Computer Architecture Intern" stays distinct from its "Computer
 * Architecture" row: a false match silently hides a role this reader never
 * applied to, which is the more expensive mistake of the two.
 */
export function titlesDescribeOneRole(a: string, b: string): boolean {
  if (a === b) return true;
  const left = identityWords(a);
  const right = identityWords(b);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  // Both directions. Against the smaller set alone, a short title matched every
  // longer one that contained it: Zipline's "Software Engineer Intern" matched
  // the ledger's "Enterprise Systems Software Engineer Intern", and TikTok's
  // plain "Machine Learning Engineer Intern" matched its "Agent Evaluation and
  // Evolution" row. Neither is the same job, and hiding a role nobody applied
  // to is the expensive mistake here.
  return shared / Math.min(left.size, right.size) >= 0.8 && shared / Math.max(left.size, right.size) >= 0.6;
}

export interface LedgerExclusionMatch {
  exclusion: LedgerExclusion;
  basis: NotionMatchBasis;
}

export function findLedgerExclusionMatch(job: { normalizedCompany: string; normalizedTitle: string; canonicalUrl: string; sourceJobId?: string }, exclusions: LedgerExclusion[]): LedgerExclusionMatch | undefined {
  for (const exclusion of exclusions) {
    if (job.sourceJobId && job.sourceJobId === exclusion.sourceJobId) return { exclusion, basis: 'SOURCE_JOB_ID' };
    // The id read out of the row's own title, scoped to the employer. The Job
    // ID column exists to hold this and a hand-filed row rarely fills it, but a
    // bare requisition number is only unique within the board that issued it,
    // so unlike the column above this one may not match across companies.
    if (job.sourceJobId && exclusion.titleJobId && job.sourceJobId === exclusion.titleJobId
      && job.normalizedCompany === exclusion.companyNormalized) return { exclusion, basis: 'SOURCE_JOB_ID' };
    if (job.canonicalUrl.startsWith('http') && job.canonicalUrl === exclusion.canonicalUrl) return { exclusion, basis: 'CANONICAL_URL' };
    if (job.normalizedCompany === exclusion.companyNormalized && titlesDescribeOneRole(job.normalizedTitle, exclusion.titleNormalized)) {
      return { exclusion, basis: 'COMPANY_TITLE' };
    }
  }
  return undefined;
}

export function findLedgerExclusion(job: { normalizedCompany: string; normalizedTitle: string; canonicalUrl: string; sourceJobId?: string }, exclusions: LedgerExclusion[]): LedgerExclusion | undefined {
  return findLedgerExclusionMatch(job, exclusions)?.exclusion;
}

export function isApplied(job: { normalizedCompany: string; normalizedTitle: string; canonicalUrl: string; sourceJobId?: string }, exclusions: LedgerExclusion[]): boolean {
  return Boolean(findLedgerExclusion(job, exclusions.filter(exclusion => exclusion.kind === 'APPLIED')));
}
