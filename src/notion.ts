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

function propertyText(property: any): string {
  if (!property) return '';
  if (property.type === 'title') return (property.title ?? []).map((item: any) => item.plain_text ?? '').join('');
  if (property.type === 'rich_text') return (property.rich_text ?? []).map((item: any) => item.plain_text ?? '').join('');
  if (property.type === 'select') return property.select?.name ?? '';
  if (property.type === 'status') return property.status?.name ?? '';
  if (property.type === 'url') return property.url ?? '';
  return '';
}

function named(properties: Record<string, any>, names: string[]): string {
  for (const name of names) {
    const entry = Object.entries(properties).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (entry) return propertyText(entry[1]);
  }
  return '';
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
      const company = named(row.properties, ['Company', 'Employer']);
      const title = named(row.properties, ['Role', 'Title', 'Name']);
      const link = named(row.properties, ['Link', 'URL', 'Application URL']);
      const sourceJobId = named(row.properties, ['Job ID', 'Source Job ID']);
      if (company && title) exclusions.push({ notionPageId: row.id, companyNormalized: normalizeText(company), titleNormalized: normalizeText(title), canonicalUrl: link ? canonicalizeUrl(link) : undefined, sourceJobId: sourceJobId || undefined });
    }
    cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
  } while (cursor);
  return exclusions;
}

export function isApplied(job: { normalizedCompany: string; normalizedTitle: string; canonicalUrl: string; sourceJobId?: string }, exclusions: AppliedExclusion[]): boolean {
  return exclusions.some(exclusion =>
    (Boolean(job.sourceJobId) && job.sourceJobId === exclusion.sourceJobId) ||
    (job.canonicalUrl.startsWith('http') && job.canonicalUrl === exclusion.canonicalUrl) ||
    (job.normalizedCompany === exclusion.companyNormalized && job.normalizedTitle === exclusion.titleNormalized)
  );
}
