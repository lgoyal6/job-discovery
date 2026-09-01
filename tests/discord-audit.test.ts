import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipelineReport } from '../src/types.js';

function configure(profile: 'technical' | 'finance' = 'technical'): void {
  vi.stubEnv('EMAIL_TO', 'laksh@example.com');
  vi.stubEnv('NOTION_DATABASE_ID', 'notion-db');
  vi.stubEnv('NOTION_DATA_SOURCE_ID', 'notion-source');
  vi.stubEnv('DISCORD_DM_CHANNEL_ID', '123456789');
  vi.stubEnv('DISCORD_BOT_TOKEN', 'bot-token');
  vi.stubEnv('JOB_PROFILE', profile === 'finance' ? 'finance' : '');
  if (profile === 'finance') {
    vi.stubEnv('FINANCE_EMAIL_TO', 'finance@example.com');
    vi.stubEnv('FINANCE_DATABASE_URL', 'postgresql://example.test/finance');
  }
}

function report(overrides: Partial<PipelineReport> = {}): PipelineReport {
  return {
    runId: '12345678-abcd-4000-8000-123456789abc', dryRun: false, batchKey: null,
    shouldSend: false, emailTo: 'laksh@example.com', subject: null, html: null, text: null,
    jobs: [], sourceRuns: [],
    counts: { raw: 120, accepted: 0, rejected: 3, deduplicated: 0, appliedExcluded: 1, ineligibleExcluded: 1, duplicateExcluded: 1 },
    rejectionReasons: { already_applied: 1, ineligible: 1, duplicate: 1 }, degradedSources: ['source-a'],
    notionExclusions: { source: 'LIVE_NOTION', samples: [
      { kind: 'INELIGIBLE', company: 'Blocked Co', title: 'Software Intern', matchBasis: 'CANONICAL_URL' },
      { kind: 'APPLIED', company: 'Applied Co', title: 'ML Intern', matchBasis: 'SOURCE_JOB_ID' },
      { kind: 'DUPLICATE', company: 'Duplicate Co', title: 'Data Intern', matchBasis: 'COMPANY_TITLE' }
    ] }, notionModified: false,
    ...overrides
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Discord run audit', () => {
  it('renders live Notion counts, one sample per kind, and the match basis', async () => {
    configure();
    const { renderDiscordAudit } = await import('../src/discord-audit.js');
    const content = renderDiscordAudit(report());

    expect(content).toContain('Notion: live');
    expect(content).toContain('Applied: 1 | Ineligible: 1 | Duplicate: 1');
    expect(content).toContain('INELIGIBLE | Blocked Co | Software Intern | URL');
    expect(content).toContain('APPLIED | Applied Co | ML Intern | job ID');
    expect(content).toContain('DUPLICATE | Duplicate Co | Data Intern | company/title');
    expect(Array.from(content)).toHaveLength(content.length);
    expect(content.length).toBeLessThanOrEqual(1800);
  });

  it('reports cached zero matches without implying a live Notion read', async () => {
    configure();
    const { renderDiscordAudit } = await import('../src/discord-audit.js');
    const content = renderDiscordAudit(report({
      counts: { raw: 90, accepted: 4, rejected: 0, deduplicated: 0, appliedExcluded: 0, ineligibleExcluded: 0, duplicateExcluded: 0 },
      notionExclusions: { source: 'CACHE', samples: [] }
    }));

    expect(content).toContain('Notion: cache');
    expect(content).toContain('Notion-suppressed postings: 0');
    expect(content).toContain('- None this run');
  });

  it('sends a mention-safe message and treats Discord refusal as non-fatal', async () => {
    configure();
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 201 }))
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    vi.stubGlobal('fetch', mockedFetch);
    const { sendDiscordAudit } = await import('../src/discord-audit.js');

    expect(await sendDiscordAudit(report())).toBe('SENT');
    const body = JSON.parse(String((mockedFetch.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content.length).toBeLessThanOrEqual(1800);
    expect(await sendDiscordAudit(report())).toBe('FAILED');
  });

  it('does not send the technical audit for finance runs', async () => {
    configure('finance');
    const mockedFetch = vi.fn();
    vi.stubGlobal('fetch', mockedFetch);
    const { sendDiscordAudit } = await import('../src/discord-audit.js');

    expect(await sendDiscordAudit(report())).toBe('SKIPPED');
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
