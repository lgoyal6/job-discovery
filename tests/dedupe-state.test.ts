import { describe, expect, it } from 'vitest';
import { isApplied } from '../src/notion.js';
import { excludeLedgerMatches, localDedupe } from '../src/pipeline.js';
import type { ClassifiedJob } from '../src/types.js';
import { batchKey, digestHash, transitionJob } from '../src/state.js';

const job = (overrides: Partial<ClassifiedJob> = {}): ClassifiedJob => ({
  sourceName: 'test', sourceJobId: '1', title: 'Software Intern Summer 2027', company: 'Acme', location: 'Remote',
  description: 'Internship', sourceUrl: 'https://feed.test', directApplyUrl: 'https://acme.test/jobs/1', scrapedAt: '2026-08-04T00:00:00Z',
  canonicalKey: 'a', canonicalUrl: 'https://acme.test/jobs/1', normalizedCompany: 'acme', normalizedTitle: 'software intern summer 2027',
  normalizedLocation: 'remote', category: 'SWE', cycle: 'Summer 2027', sponsorshipStatus: 'UNKNOWN', sponsorshipEvidence: 'none',
  graduationEligible: true, graduationEvidence: 'eligible', requiredSkills: [], score: 100, summary: 'Internship', ...overrides
});

describe('deduplication and state', () => {
  it('deduplicates equivalent jobs found by multiple sources', () => {
    const result = localDedupe([job(), job({ sourceName: 'linkedin', sourceJobId: 'li-1', canonicalKey: 'b' })]);
    expect(result.unique).toHaveLength(1);
    expect(result.count).toBe(1);
  });

  it('keeps different locations as separate roles', () => {
    // A genuinely separate requisition carries its own id; the fixture used to
    // leave it at '1', which now reads as the same posting seen twice.
    const result = localDedupe([job(), job({ sourceJobId: '2', canonicalKey: 'b', canonicalUrl: 'https://acme.test/jobs/2', directApplyUrl: 'https://acme.test/jobs/2', normalizedLocation: 'new york', location: 'New York' })]);
    expect(result.unique).toHaveLength(2);
  });

  it('collapses one requisition that two different sources link to', () => {
    // The Lever board and the speedyapply list both carried Belvedere's
    // "Quantitative Trading Intern - Winter Quarter 2027": same posting id,
    // different apply URL (/apply suffix), different spelling of Chicago, and
    // no shared canonical key because the source name is part of that key.
    const board = job({ sourceName: 'lever:belvederetrading', sourceJobId: '8f06f221-8777-4a4d-b035-40882db5f4a0', company: 'Belvedere Trading', normalizedCompany: 'belvedere trading', location: 'Chicago, Illinois', normalizedLocation: 'chicago illinois', canonicalKey: 'a', canonicalUrl: 'https://jobs.lever.co/belvederetrading/8f06f221-8777-4a4d-b035-40882db5f4a0/apply', score: 82 });
    const list = job({ sourceName: 'speedyapply-ai', sourceJobId: '8f06f221-8777-4a4d-b035-40882db5f4a0', company: 'Belvedere Trading', normalizedCompany: 'belvedere trading', location: 'Chicago, IL', normalizedLocation: 'chicago il', canonicalKey: 'b', canonicalUrl: 'https://jobs.lever.co/belvederetrading/8f06f221-8777-4a4d-b035-40882db5f4a0', score: 49 });
    const result = localDedupe([board, list]);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0]?.sourceName).toBe('lever:belvederetrading');
  });

  it('does not collapse two companies that happen to share a requisition id', () => {
    const result = localDedupe([job(), job({ company: 'Globex', normalizedCompany: 'globex', canonicalKey: 'b', canonicalUrl: 'https://globex.test/jobs/1', directApplyUrl: 'https://globex.test/jobs/1' })]);
    expect(result.unique).toHaveLength(2);
  });

  it('deduplicates repeated source IDs even when source rows disagree', () => {
    const result = localDedupe([job(), job({ canonicalUrl: 'https://other.test/jobs/alias', directApplyUrl: 'https://other.test/jobs/alias', normalizedLocation: 'new york', location: 'New York' })]);
    expect(result.unique).toHaveLength(1);
  });

  it('matches Notion applied exclusions by job ID, URL, or company/title', () => {
    const exclusions = [{ notionPageId: 'p1', companyNormalized: 'acme', titleNormalized: 'software intern summer 2027', canonicalUrl: 'https://acme.test/jobs/1', sourceJobId: '1', kind: 'APPLIED' as const }];
    expect(isApplied(job(), exclusions)).toBe(true);
    expect(isApplied(job({ sourceJobId: 'x', canonicalUrl: 'https://other.test', normalizedTitle: 'different' }), exclusions)).toBe(false);
  });

  it('suppresses applied, ineligible, and duplicate rows while keeping their reasons distinct', () => {
    const applied = job({ sourceJobId: 'applied', canonicalUrl: 'https://acme.test/jobs/applied' });
    const ineligible = job({ sourceJobId: 'ineligible', canonicalUrl: 'https://acme.test/jobs/ineligible' });
    const duplicate = job({ sourceJobId: 'duplicate', canonicalUrl: 'https://acme.test/jobs/duplicate' });
    const open = job({ sourceJobId: 'open', canonicalUrl: 'https://acme.test/jobs/open' });
    const result = excludeLedgerMatches([applied, ineligible, duplicate, open], [
      { notionPageId: 'p1', companyNormalized: 'acme', titleNormalized: 'different applied role', sourceJobId: 'applied', kind: 'APPLIED' },
      { notionPageId: 'p2', companyNormalized: 'acme', titleNormalized: 'different blocked role', sourceJobId: 'ineligible', kind: 'INELIGIBLE' },
      { notionPageId: 'p3', companyNormalized: 'acme', titleNormalized: 'different duplicate role', sourceJobId: 'duplicate', kind: 'DUPLICATE' }
    ]);

    expect(result).toEqual({ kept: [open], appliedExcluded: 1, ineligibleExcluded: 1, duplicateExcluded: 1 });
  });

  it('makes email batch identity independent of job order', () => {
    expect(digestHash(['b', 'a'])).toBe(digestHash(['a', 'b']));
    expect(batchKey(['a', 'b'], new Date('2026-08-04T12:30:00Z'))).toBe(batchKey(['b', 'a'], new Date('2026-08-04T12:59:00Z')));
  });

  it('treats Closed to Open as meaningful and clears sent state', () => {
    const result = transitionJob({ status: 'CLOSED', sentAt: '2026-08-01T00:00:00Z', materialVersion: 2 }, 'OPEN');
    expect(result).toEqual({ state: { status: 'OPEN', sentAt: null, materialVersion: 3 }, meaningfulChange: true });
    expect(transitionJob(result.state, 'OPEN').meaningfulChange).toBe(false);
  });
});
