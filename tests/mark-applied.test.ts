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
describe('the mark-applied link in the digest', () => {
  it('renders nothing at all when the secret or the URL is unset', async () => {
    const { buildDigest } = await import('../src/digest.js');
    const digest = buildDigest([role()], []);
    expect(digest.html).not.toContain('Mark applied');
    expect(digest.text).not.toContain('Mark applied');
  });

  it('renders a signed link the verifier accepts, in both HTML and text', async () => {
    configure();
    const { buildDigest } = await import('../src/digest.js');
    const { verifyJobSignature } = await import('../src/applied.js');
    const digest = buildDigest([role()], []);

    const match = digest.html.match(/href="(https:\/\/n8n\.example\.test\/webhook\/mark-applied\?[^"]+)"/);
    expect(match).not.toBeNull();
    const url = new URL(String(match?.[1]).replace(/&amp;/g, '&'));
    expect(url.searchParams.get('job')).toBe(JOB_ID);
    expect(verifyJobSignature(JOB_ID, url.searchParams.get('sig') ?? '')).toBe(true);
    expect(digest.text).toContain('Mark applied: https://n8n.example.test/webhook/mark-applied?job=');
  });

  it('rejects a signature lifted from a different job', async () => {
    configure();
    const { signJobId, verifyJobSignature } = await import('../src/applied.js');
    const other = '99999999-8888-4777-8666-555555555555';
    expect(verifyJobSignature(other, signJobId(JOB_ID))).toBe(false);
    expect(verifyJobSignature(JOB_ID, '')).toBe(false);
  });
});

describe('marking a role applied', () => {
  const mockDb = (overrides: Record<string, unknown> = {}) => {
    const recordAppliedExclusion = vi.fn().mockResolvedValue(undefined);
    const recordNotionPage = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/db.js', () => ({
      getJobForLedger: vi.fn().mockResolvedValue({ id: JOB_ID, company: 'Anduril Industries Inc', title: '2027 Software Engineer Intern', url: 'https://example.test/apply', sourceJobId: 'monster-1' }),
      loadCachedAppliedExclusions: vi.fn().mockResolvedValue([]),
      recordAppliedExclusion,
      recordNotionPage,
      ...overrides
    }));
    return { recordAppliedExclusion, recordNotionPage };
  };

  const ledgerSchema = { properties: {
    Company: { type: 'title' }, Role: { type: 'rich_text' },
    Link: { type: 'url' }, 'Job ID': { type: 'rich_text' }, Status: { type: 'select' }
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
    expect(db.recordAppliedExclusion).not.toHaveBeenCalled();
  });

  it('is a no-op the second time, so a re-clicked or scanned link files one row', async () => {
    configure();
    process.env.NOTION_TOKEN = 'test-token';
    const mockedFetch = vi.fn();
    vi.stubGlobal('fetch', mockedFetch);
    const db = mockDb({
      loadCachedAppliedExclusions: vi.fn().mockResolvedValue([
        { notionPageId: 'page-1', companyNormalized: 'anduril industries inc', titleNormalized: '2027 software engineer intern' }
      ])
    });
    const { markApplied, signJobId } = await import('../src/applied.js');

    const result = await markApplied(JOB_ID, signJobId(JOB_ID));
    expect(result).toMatchObject({ ok: true, alreadyApplied: true });
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(db.recordAppliedExclusion).not.toHaveBeenCalled();
  });

  it('writes the row under the names the reader looks for, then excludes it locally', async () => {
    configure();
    process.env.NOTION_TOKEN = 'test-token';
    // This ledger keeps the company in the page title and the role in rich
    // text, the shape readAppliedExclusions already handles. A payload built
    // from Notion's property types alone would file the company as the role.
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ledgerSchema), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'new-page-1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
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
    // Must equal the value readAppliedExclusions filters on, or the row it
    // writes is invisible to the read that excludes it.
    expect(body.properties.Status.select).toEqual({ name: 'Applied' });

    expect(db.recordAppliedExclusion).toHaveBeenCalledWith(expect.objectContaining({
      notionPageId: 'new-page-1', companyNormalized: 'anduril industries inc', titleNormalized: '2027 software engineer intern'
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
    expect(JSON.parse(String(init.body)).properties.Status.select).toEqual({ name: 'Applied' });
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
    expect(db.recordAppliedExclusion).not.toHaveBeenCalled();
  });
});
