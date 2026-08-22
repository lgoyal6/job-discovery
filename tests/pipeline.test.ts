import { describe, expect, it } from 'vitest';
import { runPipeline } from '../src/pipeline.js';

describe('fixture dry run', () => {
  it('produces the expected no-send digest and degraded credential reporting', async () => {
    const report = await runPipeline({ fixtures: true, persistent: false });
    expect(report.dryRun).toBe(true);
    expect(report.shouldSend).toBe(false);
    expect(report.notionModified).toBe(false);
    // A posting that says it cannot sponsor is reported, not rejected: the
    // wording is boilerplate that employers do depart from.
    expect(report.counts).toMatchObject({ raw: 7, accepted: 4, deduplicated: 1 });
    expect(report.jobs.map(job => job.sponsorshipStatus).sort()).toEqual(['SUPPORTED', 'SUPPORTED', 'UNKNOWN', 'UNSUPPORTED']);
    expect(report.rejectionReasons.sponsorship_unsupported).toBeUndefined();
    expect(report.subject).toContain('4 roles');
    // The report still records every source that did not succeed, which is what
    // a diagnostic field is for.
    expect(report.degradedSources).toEqual(expect.arrayContaining(['notion-applied', 'apify:linkedin', 'apify:monster']));
    // The email does not, unless one of them actually failed. In fixture mode
    // they are all skipped on purpose, and a reader told that a deliberately
    // disabled credential is "degraded coverage" learns to skip the section.
    expect(report.html).not.toContain('Source failures or degraded coverage');
    const order = ['Strong Summer 2027 matches', 'Other target-cycle matches', 'Sponsorship unclear', 'Says no sponsorship, decide for yourself']
      .map(heading => report.html!.indexOf(heading));
    expect(order.every(position => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
