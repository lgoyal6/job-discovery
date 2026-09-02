import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DigestJob } from '../src/types.js';

const SECRET = 'test-mark-applied-secret';
const JOB_ID = '11111111-2222-4333-8444-555555555555';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const key of ['MARK_APPLIED_SECRET', 'MARK_APPLIED_BASE_URL', 'NOTION_TOKEN']) delete process.env[key];
});

function configure(): void {
  process.env.MARK_APPLIED_SECRET = SECRET;
  process.env.MARK_APPLIED_BASE_URL = 'https://n8n.example.test/webhook/mark-applied';
}

const role = (): DigestJob => ({
  id: JOB_ID, sourceName: 'apify:monster', title: '2027 Software Engineer Intern', company: 'Anduril Industries Inc',
  location: 'Atlanta, GA', sourceUrl: 'https://example.test/listing', directApplyUrl: 'https://example.test/apply',
  scrapedAt: new Date().toISOString(), canonicalKey: 'anduril|swe', canonicalUrl: 'https://example.test/apply',
  normalizedCompany: 'anduril industries', normalizedTitle: 'software engineer intern', normalizedLocation: 'atlanta ga',
  category: 'SWE', cycle: 'Summer 2027', sponsorshipStatus: 'UNKNOWN', sponsorshipEvidence: 'none',
  graduationEligible: true, graduationEvidence: '', requiredSkills: ['Python'], score: 99, summary: 'A role.'
});

// ---------------------------------------------------------------------------
// The link is the whole feature's attack surface: it sits in an email, and it
// writes to the ledger. Unconfigured it must not render at all, and configured
// it must not be forgeable from the job id alone.
// ---------------------------------------------------------------------------
describe('the digest carries a ref, not a link', () => {
  // The link was removed: applications are filed by the resume build, which
  // calls `applied <ref>` the moment a PDF renders, so a button nobody pressed
  // was a second source of truth that could only ever disagree with the first.
  it('prints a short job ref and no Mark applied link', async () => {
    configure();
    const { buildDigest } = await import('../src/digest.js');
    const digest = buildDigest([role()], []);
    expect(digest.html).not.toContain('Mark applied');
    expect(digest.text).not.toContain('Mark applied');
    expect(digest.text).toMatch(/ref [0-9a-f]{8}/);
  });
});

describe('marking a role applied', () => {
  const mockDb = (overrides: Record<string, unknown> = {}) => {
    const recordLedgerExclusion = vi.fn().mockResolvedValue(undefined);
    const recordNotionPage = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/db.js', () => ({
      getJobForLedger: vi.fn().mockResolvedValue({ id: JOB_ID, company: 'Anduril Industries Inc', title: '2027 Software Engineer Intern', url: 'https://example.test/apply', sourceJobId: 'monster-1' }),
      loadCachedLedgerExclusions: vi.fn().mockResolvedValue([]),
      recordLedgerExclusion,
      recordNotionPage,
      ...overrides
    }));
    return { recordLedgerExclusion, recordNotionPage };
  };

  const ledgerSchema = { properties: {
    Company: { type: 'title' }, Role: { type: 'rich_text' },
    Link: { type: 'url' }, 'Job ID': { type: 'rich_text' }, Status: { type: 'select' },
    Purge: { type: 'select' }, 'Date Applied': { type: 'date' }
  } };

  it('refuses a forged link without reading the database or writing to Notion', async () => {
    configure();
    process.env.NOTION_TOKEN = 'test-token';
    const mockedFetch = vi.fn();
    vi.stubGlobal('fetch', mockedFetch);
    const db = mockDb();
    const { markApplied } = await import('../src/applied.js');

    expect(await markApplied(JOB_ID, 'f'.repeat(32))).toEqual({ ok: false, reason: 'bad_signature' });
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(db.recordLedgerExclusion).not.toHaveBeenCalled();
  });

  it('is a no-op the second time, so a re-clicked or scanned link files one row', async () => {
    configure();
    process.env.NOTION_TOKEN = 'test-token';
    const mockedFetch = vi.fn();
    vi.stubGlobal('fetch', mockedFetch);
    const db = mockDb({
      loadCachedLedgerExclusions: vi.fn().mockResolvedValue([
        { notionPageId: 'page-1', companyNormalized: 'anduril industries inc', titleNormalized: '2027 software engineer intern', kind: 'APPLIED' }
      ])
    });
    const { markApplied, signJobId } = await import('../src/applied.js');

    const result = await markApplied(JOB_ID, signJobId(JOB_ID));
    expect(result).toMatchObject({ ok: true, alreadyApplied: true });
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(db.recordLedgerExclusion).not.toHaveBeenCalled();
  });

  it('writes the row under the names the reader looks for, then excludes it locally', async () => {
    configure();
    process.env.NOTION_TOKEN = 'test-token';
    // This ledger keeps the company in the page title and the role in rich
    // text, the shape readLedgerExclusions already handles. A payload built
    // from Notion's property types alone would file the company as the role.
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const mockedFetch = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(String(url).includes('/pages') ? json({ id: 'new-page-1' }) : json(ledgerSchema)));
    vi.stubGlobal('fetch', mockedFetch);
    const db = mockDb();
    const { markApplied, signJobId } = await import('../src/applied.js');

    const result = await markApplied(JOB_ID, signJobId(JOB_ID));
    expect(result).toMatchObject({ ok: true, notionPageId: 'new-page-1', company: 'Anduril Industries Inc' });

    const [createUrl, createInit] = mockedFetch.mock.calls[1] as [string, RequestInit];
    expect(createUrl).toBe('https://api.notion.com/v1/pages');
    expect(createInit.method).toBe('POST');
    const body = JSON.parse(String(createInit.body));
    expect(body.parent).toEqual({ type: 'data_source_id', data_source_id: process.env.NOTION_DATA_SOURCE_ID });
    expect(body.properties.Company.title[0].text.content).toBe('Anduril Industries Inc');
    expect(body.properties.Role.rich_text[0].text.content).toBe('2027 Software Engineer Intern');
    expect(body.properties.Link.url).toBe('https://example.test/apply');
    expect(body.properties['Job ID'].rich_text[0].text.content).toBe('monster-1');
    // Must equal the value readLedgerExclusions filters on, or the row it
    // writes is invisible to the read that excludes it.
    expect(body.properties.Status.select).toEqual({ name: 'Applied' });

    expect(db.recordLedgerExclusion).toHaveBeenCalledWith(expect.objectContaining({
      notionPageId: 'new-page-1', companyNormalized: 'anduril industries inc', titleNormalized: '2027 software engineer intern', kind: 'APPLIED'
    }));
  });

  // Dies if marking applied goes back to always creating. With the mirror on,
  // the role already has a row, and creating a second one leaves two rows for
  // one posting with only one of them true.
  it('moves the row the mirror already filed instead of filing a second one', async () => {
    configure();
    process.env.NOTION_TOKEN = 'test-token';
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ledgerSchema), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'mirrored-page' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', mockedFetch);
    mockDb({
      getJobForLedger: vi.fn().mockResolvedValue({
        id: JOB_ID, company: 'Anduril Industries Inc', title: '2027 Software Engineer Intern',
        url: 'https://example.test/apply', sourceJobId: 'monster-1', notionPageId: 'mirrored-page'
      })
    });
    const { markApplied, signJobId } = await import('../src/applied.js');

    const result = await markApplied(JOB_ID, signJobId(JOB_ID));
    expect(result).toMatchObject({ ok: true, notionPageId: 'mirrored-page' });

    const [url, init] = mockedFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.notion.com/v1/pages/mirrored-page');
    expect(init.method).toBe('PATCH');
    const properties = JSON.parse(String(init.body)).properties;
    expect(properties.Status.select).toEqual({ name: 'Applied' });
    expect(properties['Date Applied'].date).toEqual({ start: expect.any(String) });
    expect(properties.Purge.select).toBeNull();
  });

  it('overrides an existing ineligible row instead of creating a competing applied row', async () => {
    configure();
    process.env.NOTION_TOKEN = 'test-token';
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ledgerSchema), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'blocked-page' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', mockedFetch);
    const db = mockDb({
      loadCachedLedgerExclusions: vi.fn().mockResolvedValue([{
        notionPageId: 'blocked-page', companyNormalized: 'anduril industries inc',
        titleNormalized: '2027 software engineer intern', canonicalUrl: 'https://example.test/apply',
        sourceJobId: 'monster-1', kind: 'INELIGIBLE'
      }])
    });
    const { markApplied, signJobId } = await import('../src/applied.js');

    const result = await markApplied(JOB_ID, signJobId(JOB_ID));

    expect(result).toMatchObject({ ok: true, notionPageId: 'blocked-page' });
    expect(mockedFetch.mock.calls.some(call => call[0] === 'https://api.notion.com/v1/pages')).toBe(false);
    expect(db.recordNotionPage).toHaveBeenCalledWith(JOB_ID, 'blocked-page');
    expect(db.recordLedgerExclusion).toHaveBeenCalledWith(expect.objectContaining({ notionPageId: 'blocked-page', kind: 'APPLIED' }));
  });

  it('reports a Notion failure instead of throwing, and records no exclusion', async () => {
    configure();
    process.env.NOTION_TOKEN = 'test-token';
    const mockedFetch = vi.fn().mockResolvedValue(new Response('nope', { status: 403 }));
    vi.stubGlobal('fetch', mockedFetch);
    const db = mockDb();
    const { markApplied, signJobId } = await import('../src/applied.js');

    const result = await markApplied(JOB_ID, signJobId(JOB_ID));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('notion_failed');
    expect(db.recordLedgerExclusion).not.toHaveBeenCalled();
  });
});
