import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.NOTION_TOKEN;
  vi.resetModules();
});

describe('Notion digest exclusions', () => {
  it('paginates query-only reads for terminal decisions without mutations', async () => {
    process.env.NOTION_TOKEN = 'test-notion-token';
    process.env.NOTION_DATA_SOURCE_ID = 'test-data-source';
    const pages = [
      { results: [{ id: 'page-1', properties: {
        Company: { type: 'title', title: [{ plain_text: 'GitHub' }] },
        Role: { type: 'rich_text', rich_text: [{ plain_text: 'Software Intern' }] },
        URL: { type: 'url', url: 'https://example.test/jobs/1?utm_source=notion' },
        'Job ID': { type: 'rich_text', rich_text: [{ plain_text: 'job-1' }] }
      } }], has_more: true, next_cursor: 'cursor-2' },
      { results: [{ id: 'page-2', properties: {
        Employer: { type: 'title', title: [{ plain_text: 'Acme' }] },
        Title: { type: 'rich_text', rich_text: [{ plain_text: 'ML Intern' }] }
      } }], has_more: false, next_cursor: null }
    ];
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(pages[0]), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(pages[1]), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', mockedFetch);
    const { readAppliedExclusions } = await import('../src/notion.js');

    const rows = await readAppliedExclusions();
    expect(rows).toEqual([
      { notionPageId: 'page-1', companyNormalized: 'github', titleNormalized: 'software intern', canonicalUrl: 'https://example.test/jobs/1', sourceJobId: 'job-1' },
      { notionPageId: 'page-2', companyNormalized: 'acme', titleNormalized: 'ml intern', canonicalUrl: undefined, sourceJobId: undefined }
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
      { property: 'Purge', select: { equals: 'Ineligible - delete' } },
      { property: 'Purge', select: { equals: 'Duplicate - delete' } }
    ] });
    expect(secondBody.filter).toEqual(firstBody.filter);
    expect(secondBody.start_cursor).toBe('cursor-2');
  });
});
