import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.NOTION_TOKEN;
  vi.resetModules();
});

describe('Notion exclusion ledger', () => {
  it('paginates query-only reads for applied, ineligible, and duplicate decisions without mutations', async () => {
    process.env.NOTION_TOKEN = 'test-notion-token';
    process.env.NOTION_DATA_SOURCE_ID = 'test-data-source';
    const pages = [
      { results: [{ id: 'page-1', properties: {
        Company: { type: 'title', title: [{ plain_text: 'GitHub' }] },
        Role: { type: 'rich_text', rich_text: [{ plain_text: 'Software Intern' }] },
        URL: { type: 'url', url: 'https://example.test/jobs/1?utm_source=notion' },
        'Job ID': { type: 'rich_text', rich_text: [{ plain_text: 'job-1' }] },
        Status: { type: 'select', select: { name: 'Applied' } }
      } }], has_more: true, next_cursor: 'cursor-2' },
      { results: [
        { id: 'page-2', properties: {
          Employer: { type: 'title', title: [{ plain_text: 'Acme' }] },
          Title: { type: 'rich_text', rich_text: [{ plain_text: 'ML Intern' }] },
          Status: { type: 'select', select: { name: 'Ineligible' } }
        } },
        { id: 'page-3', properties: {
          Company: { type: 'title', title: [{ plain_text: 'Legacy Corp' }] },
          Role: { type: 'rich_text', rich_text: [{ plain_text: 'Graduate Intern' }] },
          Status: { type: 'select', select: { name: 'New' } },
          Purge: { type: 'select', select: { name: 'Ineligible - delete' } }
        } },
        { id: 'page-4', properties: {
          Company: { type: 'title', title: [{ plain_text: 'Rejected Corp' }] },
          Role: { type: 'rich_text', rich_text: [{ plain_text: 'Backend Intern' }] },
          Status: { type: 'select', select: { name: 'Rejected' } }
        } },
        { id: 'page-5', properties: {
          Company: { type: 'title', title: [{ plain_text: 'Duplicate Corp' }] },
          Role: { type: 'rich_text', rich_text: [{ plain_text: 'SWE Intern' }] },
          Status: { type: 'select', select: { name: 'New' } },
          Purge: { type: 'select', select: { name: 'Duplicate - delete' } }
        } }
      ], has_more: false, next_cursor: null }
    ];
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(pages[0]), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(pages[1]), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', mockedFetch);
    const { readLedgerExclusions } = await import('../src/notion.js');

    const rows = await readLedgerExclusions();
    expect(rows).toEqual([
      { notionPageId: 'page-1', companyNormalized: 'github', titleNormalized: 'software intern', canonicalUrl: 'https://example.test/jobs/1', sourceJobId: 'job-1', kind: 'APPLIED' },
      { notionPageId: 'page-2', companyNormalized: 'acme', titleNormalized: 'ml intern', canonicalUrl: undefined, sourceJobId: undefined, kind: 'INELIGIBLE' },
      { notionPageId: 'page-3', companyNormalized: 'legacy corp', titleNormalized: 'graduate intern', canonicalUrl: undefined, sourceJobId: undefined, kind: 'INELIGIBLE' },
      { notionPageId: 'page-4', companyNormalized: 'rejected corp', titleNormalized: 'backend intern', canonicalUrl: undefined, sourceJobId: undefined, kind: 'APPLIED' },
      { notionPageId: 'page-5', companyNormalized: 'duplicate corp', titleNormalized: 'swe intern', canonicalUrl: undefined, sourceJobId: undefined, kind: 'DUPLICATE' }
    ]);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    for (const call of mockedFetch.mock.calls) {
      expect(call[0]).toBe('https://api.notion.com/v1/data_sources/test-data-source/query');
      expect((call[1] as RequestInit).method).toBe('POST');
    }
    const firstBody = JSON.parse(String((mockedFetch.mock.calls[0]?.[1] as RequestInit).body));
    const secondBody = JSON.parse(String((mockedFetch.mock.calls[1]?.[1] as RequestInit).body));
    expect(firstBody.filter).toEqual({ or: [
      { property: 'Status', select: { equals: 'Applied' } },
      { property: 'Status', select: { equals: 'In Review' } },
      { property: 'Status', select: { equals: 'Interview' } },
      { property: 'Status', select: { equals: 'Offer' } },
      { property: 'Status', select: { equals: 'Rejected' } },
      { property: 'Status', select: { equals: 'Ineligible' } },
      { property: 'Purge', select: { equals: 'Ineligible - delete' } },
      { property: 'Purge', select: { equals: 'Duplicate - delete' } }
    ] });
    expect(secondBody.filter).toEqual(firstBody.filter);
    expect(secondBody.start_cursor).toBe('cursor-2');
  });

  it('marks a declined build Ineligible without using Purge or Date Applied', async () => {
    process.env.NOTION_TOKEN = 'test-notion-token';
    process.env.NOTION_DATA_SOURCE_ID = 'test-data-source';
    const schema = { properties: {
      Status: { type: 'select', select: { options: [{ name: 'Applied' }, { name: 'Ineligible' }] } },
      Purge: { type: 'select', select: { options: [{ name: 'Ineligible - delete' }] } },
      'Date Applied': { type: 'date' }
    } };
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(schema), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'page-6' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', mockedFetch);
    const { setLedgerStatus } = await import('../src/notion.js');

    await setLedgerStatus('page-6', 'Ineligible');

    const [url, init] = mockedFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.notion.com/v1/pages/page-6');
    const properties = JSON.parse(String(init.body)).properties;
    expect(properties.Status.select).toEqual({ name: 'Ineligible' });
    expect(properties.Purge.select).toBeNull();
    expect(properties['Date Applied'].date).toBeNull();
  });
});
