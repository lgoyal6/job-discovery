import { z } from 'zod';
import { config } from './config.js';
import { fetchWithPolicy } from './http.js';
import { canonicalizeUrl, normalizeText } from './normalization.js';

export interface AppliedExclusion {
  notionPageId: string;
  companyNormalized: string;
  titleNormalized: string;
  canonicalUrl?: string;
  sourceJobId?: string;
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
  status: ['Status']
} as const;

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

export async function readAppliedExclusions(): Promise<AppliedExclusion[]> {
  if (!config.NOTION_TOKEN) return [];
  const exclusions: AppliedExclusion[] = [];
  let cursor: string | undefined;
  let useLegacyDatabaseQuery = false;
  do {
    // The ledger uses a Status *select* property (not the newer Status type).
    // Keep this shape compatible with both the data-source and legacy query APIs.
    const body = JSON.stringify({ page_size: 100, filter: { property: 'Status', select: { equals: 'Applied' } }, ...(cursor ? { start_cursor: cursor } : {}) });
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
      const title = named(row.properties, LEDGER_FIELDS.title);
      const link = named(row.properties, LEDGER_FIELDS.url);
      const sourceJobId = named(row.properties, LEDGER_FIELDS.sourceJobId);
      if (company && title) exclusions.push({ notionPageId: row.id, companyNormalized: normalizeText(company), titleNormalized: normalizeText(title), canonicalUrl: link ? canonicalizeUrl(link) : undefined, sourceJobId: sourceJobId || undefined });
    }
    cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
  } while (cursor);
  return exclusions;
}

export interface AppliedLedgerEntry { company: string; title: string; url?: string; sourceJobId?: string }

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
  const values: Array<[readonly string[], string]> = [
    [LEDGER_FIELDS.company, entry.company],
    [LEDGER_FIELDS.title, entry.title],
    [LEDGER_FIELDS.url, entry.url ?? ''],
    [LEDGER_FIELDS.sourceJobId, entry.sourceJobId ?? ''],
    [LEDGER_FIELDS.status, status]
  ];
  const properties: Record<string, unknown> = {};
  for (const [names, value] of values) {
    const found = findProperty(schema, names);
    if (!found || !value) continue;
    const [name, definition] = found;
    const encoded = encodeProperty(String(definition.type), value);
    if (encoded) properties[name] = encoded;
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
export async function setLedgerStatus(pageId: string, status: string): Promise<void> {
  const { version, schema } = await ledgerBinding();
  const found = findProperty(schema, LEDGER_FIELDS.status);
  if (!found) throw new Error('The ledger has no Status property to update.');
  const encoded = encodeProperty(String(found[1].type), status);
  if (!encoded) throw new Error(`The ledger's Status property is a ${String(found[1].type)}, which cannot carry a name.`);
  await notionCall(`https://api.notion.com/v1/pages/${pageId}`, version, {
    method: 'PATCH', body: JSON.stringify({ properties: { [found[0]]: encoded } })
  });
}

function encodeProperty(type: string, value: string): unknown {
  const text = [{ type: 'text', text: { content: value.slice(0, 2000) } }];
  if (type === 'title') return { title: text };
  if (type === 'rich_text') return { rich_text: text };
  if (type === 'url') return { url: value };
  if (type === 'select') return { select: { name: value } };
  if (type === 'status') return { status: { name: value } };
  return undefined;
}

export function isApplied(job: { normalizedCompany: string; normalizedTitle: string; canonicalUrl: string; sourceJobId?: string }, exclusions: AppliedExclusion[]): boolean {
  return exclusions.some(exclusion =>
    (Boolean(job.sourceJobId) && job.sourceJobId === exclusion.sourceJobId) ||
    (job.canonicalUrl.startsWith('http') && job.canonicalUrl === exclusion.canonicalUrl) ||
    (job.normalizedCompany === exclusion.companyNormalized && job.normalizedTitle === exclusion.titleNormalized)
  );
}
