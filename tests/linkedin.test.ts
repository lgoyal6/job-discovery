import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLinkedInCards } from '../src/sources/linkedin.js';

const source = { name: 'linkedin:swe-intern', cycle: 'Summer 2027' };

describe('LinkedIn guest card parsing', () => {
  it('extracts the fields dedupe and the digest need from a real response', async () => {
    const html = await readFile(resolve(process.cwd(), 'fixtures/linkedin-guest.html'), 'utf8');
    const jobs = parseLinkedInCards(html, source, '2026-08-08T00:00:00Z');
    expect(jobs.length).toBeGreaterThan(5);
    const first = jobs[0];
    expect(first?.sourceJobId).toMatch(/^\d+$/);
    expect(first?.company).toBeTruthy();
    expect(first?.title).toBeTruthy();
    expect(first?.cycleHint).toBe('Summer 2027');
    // Tracking parameters differ on every impression, so leaving them on would
    // make the same posting look new each run.
    expect(first?.directApplyUrl).not.toContain('trackingId');
    expect(first?.directApplyUrl).not.toContain('?');
  });

  it('drops cards missing an id, title or company rather than inventing rows', () => {
    const html = '<li><div class="base-card" data-entity-urn="urn:li:jobPosting:123"></div></li>';
    expect(parseLinkedInCards(html, source)).toHaveLength(0);
  });

  // If LinkedIn changes its markup this returns nothing, which reads exactly
  // like a quiet day. The source treats that as a failure; the parser's job is
  // only to be honest about finding nothing.
  it('returns nothing when the markup no longer matches', () => {
    expect(parseLinkedInCards('<div class="totally-new-markup">Engineer</div>', source)).toHaveLength(0);
  });
});
