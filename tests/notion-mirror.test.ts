import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const key of ['NOTION_MIRROR_ENABLED', 'NOTION_MIRROR_MAX_PER_RUN', 'NOTION_MIRROR_STATUS', 'NOTION_TOKEN']) delete process.env[key];
});

const LEDGER_SCHEMA = { properties: {
  Company: { type: 'title' }, Role: { type: 'rich_text' },
  Link: { type: 'url' }, 'Job ID': { type: 'rich_text' }, Status: { type: 'select' }
} };

const pending = [
  { id: '11111111-1111-4111-8111-111111111111', company: 'Tiktok', title: 'Software Engineer Intern 2027', url: 'https://example.test/1', sourceJobId: 'src-1' },
  { id: '22222222-2222-4222-8222-222222222222', company: 'Anduril', title: '2027 Software Engineer Intern', url: 'https://example.test/2', sourceJobId: 'src-2' }
];

function mockDb(rows = pending) {
  const getJobsToMirror = vi.fn().mockResolvedValue(rows);
  const recordNotionPage = vi.fn().mockResolvedValue(undefined);
  vi.doMock('../src/db.js', () => ({ getJobsToMirror, recordNotionPage }));
  return { getJobsToMirror, recordNotionPage };
}

describe('mirroring postings into the Notion ledger', () => {
  it('writes nothing at all until it is switched on', async () => {
    process.env.NOTION_TOKEN = 'test-token';
    const mockedFetch = vi.fn();
    vi.stubGlobal('fetch', mockedFetch);
    const db = mockDb();
    const { mirrorNewPostings } = await import('../src/mirror.js');

    expect(await mirrorNewPostings('run-1')).toEqual({ attempted: 0, created: 0, failed: 0 });
    expect(db.getJobsToMirror).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  // The invariant the whole feature rests on. readAppliedExclusions filters
  // Status = Applied, so a mirrored posting written under that status would
  // come back next run as a role already applied to, and every role the
  // pipeline found would exclude itself.
  it('files postings under a status the applied read ignores, and remembers the page', async () => {
    process.env.NOTION_TOKEN = 'test-token';
    process.env.NOTION_MIRROR_ENABLED = 'true';
    // A fresh Response per call: a body can only be read once, so a shared one
    // makes the second page fail for a reason that has nothing to do with the
    // code under test.
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const mockedFetch = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(String(url).includes('/pages') ? json({ id: 'page-x' }) : json(LEDGER_SCHEMA)));
    vi.stubGlobal('fetch', mockedFetch);
    const db = mockDb();
    const { mirrorNewPostings } = await import('../src/mirror.js');

    const result = await mirrorNewPostings('run-1');
    expect(result).toMatchObject({ attempted: 2, created: 2, failed: 0 });

    const creates = mockedFetch.mock.calls.filter(call => call[0] === 'https://api.notion.com/v1/pages');
    expect(creates).toHaveLength(2);
    for (const [, init] of creates as Array<[string, RequestInit]>) {
      const body = JSON.parse(String(init.body));
      expect(body.properties.Status.select.name).toBe('New');
      expect(body.properties.Status.select.name).not.toBe('Applied');
    }
    // The schema is read once, not once per page.
    expect(mockedFetch.mock.calls.filter(call => String(call[0]).includes('/data_sources/'))).toHaveLength(1);
    expect(db.recordNotionPage).toHaveBeenCalledTimes(2);
    expect(db.recordNotionPage).toHaveBeenCalledWith(pending[0]!.id, 'page-x');
  }, 15_000);

  it('asks for no more than the per-run cap', async () => {
    process.env.NOTION_TOKEN = 'test-token';
    process.env.NOTION_MIRROR_ENABLED = 'true';
    process.env.NOTION_MIRROR_MAX_PER_RUN = '25';
    vi.stubGlobal('fetch', vi.fn());
    const db = mockDb([]);
    const { mirrorNewPostings } = await import('../src/mirror.js');

    await mirrorNewPostings('run-1');
    expect(db.getJobsToMirror).toHaveBeenCalledWith(25);
  });

  // The digest is the product; the ledger is a record of it. A workspace that
  // is down must cost the run its mirror and nothing else.
  it('never throws when Notion refuses, and records no page for a failed write', async () => {
    process.env.NOTION_TOKEN = 'test-token';
    process.env.NOTION_MIRROR_ENABLED = 'true';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));
    const db = mockDb();
    const { mirrorNewPostings } = await import('../src/mirror.js');

    const result = await mirrorNewPostings('run-1');
    expect(result.created).toBe(0);
    expect(result.failed).toBeGreaterThan(0);
    expect(db.recordNotionPage).not.toHaveBeenCalled();
  }, 15_000);

  it('refuses to start if the mirror status is the one the applied read filters on', async () => {
    process.env.NOTION_MIRROR_STATUS = 'Applied';
    await expect(import('../src/config.js')).rejects.toThrow(/NOTION_MIRROR_STATUS/);
  });
});
