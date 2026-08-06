import { describe, expect, it } from 'vitest';
import { runPipeline } from '../src/pipeline.js';

describe('fixture dry run', () => {
  it('produces the expected no-send digest and degraded credential reporting', async () => {
    const report = await runPipeline({ fixtures: true, persistent: false });
    expect(report.dryRun).toBe(true);
    expect(report.shouldSend).toBe(false);
    expect(report.notionModified).toBe(false);
    expect(report.counts).toMatchObject({ raw: 7, accepted: 3, deduplicated: 1 });
    expect(report.jobs.map(job => job.sponsorshipStatus).sort()).toEqual(['SUPPORTED', 'SUPPORTED', 'UNKNOWN']);
    expect(report.subject).toContain('3 roles');
    expect(report.degradedSources).toEqual(expect.arrayContaining(['notion-applied', 'apify:linkedin', 'apify:indeed', 'apify:monster']));
    expect(report.html!.indexOf('Strong Summer 2027 matches')).toBeLessThan(report.html!.indexOf('Other target-cycle matches'));
    expect(report.html!.indexOf('Other target-cycle matches')).toBeLessThan(report.html!.indexOf('Sponsorship unclear'));
    expect(report.html!.indexOf('Sponsorship unclear')).toBeLessThan(report.html!.indexOf('Source failures or degraded coverage'));
  });
});
