import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkdayPostedOn, isoOrUndefined } from '../src/sources/ats.js';
import type { DigestJob } from '../src/types.js';

// ---------------------------------------------------------------------------
// The finance email, as its reader asked for it: three sections, newest first,
// and a date on every row that a human can read.
// ---------------------------------------------------------------------------

const role = (over: Partial<DigestJob>): DigestJob => ({
  sourceName: 'linkedin:equity-research', title: 'Equity Research Summer Analyst', company: 'A Firm',
  location: 'New York, NY', sourceUrl: 'https://example.test/listing', directApplyUrl: 'https://example.test/apply',
  scrapedAt: '2026-08-20T00:00:00.000Z', canonicalKey: `key-${over.title ?? ''}${over.company ?? ''}`,
  canonicalUrl: 'https://example.test/apply', normalizedCompany: 'a firm', normalizedTitle: 'equity research summer analyst',
  normalizedLocation: 'new york ny', category: 'IB', cycle: 'Summer 2027', sponsorshipStatus: 'UNKNOWN',
  sponsorshipEvidence: 'The posting does not state a policy.', graduationEligible: true, graduationEvidence: '',
  requiredSkills: [], score: 50, summary: 'A role.', ...over
});

async function financeDigest(jobs: DigestJob[]): Promise<{ subject: string; html: string; text: string }> {
  vi.resetModules();
  vi.stubEnv('JOB_PROFILE', 'finance');
  vi.stubEnv('FINANCE_EMAIL_TO', 'someone@example.edu');
  const { buildDigest } = await import('../src/digest.js');
  return buildDigest(jobs, []);
}

describe('the finance digest', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('splits into investing, finance, and roles that require sponsorship or citizenship', async () => {
    const digest = await financeDigest([
      role({ title: 'Private Equity Summer Analyst', company: 'Buyside', category: 'PE/VC' }),
      role({ title: 'Intern, Finance', company: 'A Cruise Line', category: 'Corp Fin' }),
      role({ title: 'Investment Banking Analyst', company: 'Citizens Only Bank', category: 'IB', sponsorshipStatus: 'UNSUPPORTED', sponsorshipEvidence: 'Requires U.S. citizenship.' })
    ]);
    const headings = [...digest.html.matchAll(/<h2>([^<]*)<\/h2>/g)].map(match => match[1]);
    expect(headings).toEqual(['Investing', 'Corporate finance', 'Sponsorship or citizenship required (listed so nothing is missed)']);

    // Each row under the heading that describes what the job is, not merely
    // where it came from. The corporate-finance tail is kept, and kept apart:
    // that separation is the whole reason it is allowed in at all.
    const investing = digest.html.slice(digest.html.indexOf('Investing'), digest.html.indexOf('>Corporate finance<'));
    expect(investing).toContain('Private Equity Summer Analyst');
    expect(investing).not.toContain('Intern, Finance');
    const financeSection = digest.html.slice(digest.html.indexOf('>Corporate finance<'), digest.html.indexOf('Sponsorship or citizenship'));
    expect(financeSection).toContain('Intern, Finance');
  });

  it('sends a role that cannot sponsor to the last section whatever it is', async () => {
    // It is carried so that nothing found is silently dropped, not because it
    // is a match, so a private equity role that requires citizenship still
    // leaves the investing section.
    const digest = await financeDigest([
      role({ title: 'Private Equity Summer Analyst', category: 'PE/VC', sponsorshipStatus: 'UNSUPPORTED', sponsorshipEvidence: 'Listed with 🇺🇸.' })
    ]);
    const headings = [...digest.html.matchAll(/<h2>([^<]*)<\/h2>/g)].map(match => match[1]);
    expect(headings).toEqual(['Sponsorship or citizenship required (listed so nothing is missed)']);
  });

  it('orders every section newest first, and breaks a tie on score', async () => {
    const digest = await financeDigest([
      role({ title: 'Posted three weeks ago', company: 'Old', postedAt: '2026-07-30T00:00:00.000Z', score: 200 }),
      role({ title: 'Posted today', company: 'New', postedAt: '2026-08-20T00:00:00.000Z', score: 10 }),
      role({ title: 'Posted today but scores higher', company: 'Newer', postedAt: '2026-08-20T00:00:00.000Z', score: 90 })
    ]);
    const order = ['Posted today but scores higher', 'Posted today', 'Posted three weeks ago']
      .map(title => digest.text.indexOf(title));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every(index => index >= 0)).toBe(true);
  });

  it('prints the day a role was posted, without moving it across a timezone', async () => {
    // A list that dates by the day writes midnight UTC. Rendered in Pacific
    // time that is 5pm the day before, which reported every intern-list role as
    // posted a day earlier than it was.
    const digest = await financeDigest([role({ postedAt: '2026-08-20T00:00:00.000Z' })]);
    expect(digest.text).toContain('Posted: Aug 20, 2026');
  });

  it('says so plainly when the source never dated the posting', async () => {
    const digest = await financeDigest([role({ postedAt: undefined, firstSeenAt: '2026-08-18T00:00:00.000Z' })]);
    expect(digest.text).toContain('Posted: Not stated by the source, first seen Aug 18, 2026');
  });

  it('never prints Invalid Date, whatever the source called a date', async () => {
    // Workday answers "Posted 30+ Days Ago" and that string used to be carried
    // through to the email verbatim.
    const digest = await financeDigest([role({ postedAt: 'Posted 30+ Days Ago' })]);
    expect(digest.html).not.toContain('Invalid Date');
    expect(digest.text).toContain('Not stated by the source');
  });

  it('offers one apply link per role, and a second link only when it goes somewhere else', async () => {
    // On every ATS board the posting and its application form are one URL.
    // Rendering it twice, as "Source" and as "Direct application", is what made
    // the digest look like it carried a broken second link on every row.
    const same = await financeDigest([role({ sourceUrl: 'https://example.test/job/1', directApplyUrl: 'https://example.test/job/1' })]);
    expect(same.text).toContain('Apply: https://example.test/job/1');
    expect(same.text).not.toContain('Listing:');

    const different = await financeDigest([role({ sourceUrl: 'https://example.test/list', directApplyUrl: 'https://boards.greenhouse.io/x/jobs/1' })]);
    expect(different.text).toContain('Apply: https://boards.greenhouse.io/x/jobs/1');
    expect(different.text).toContain('Listing: https://example.test/list');
  });

  it('falls back to the listing when a source has no application link of its own', async () => {
    // intern-list rows, whose apply button leads to an account wall rather than
    // to the employer. The row still has to be clickable.
    const digest = await financeDigest([role({ sourceUrl: 'https://www.intern-list.com/x/role_1', directApplyUrl: undefined })]);
    expect(digest.text).toContain('Apply: https://www.intern-list.com/x/role_1');
    expect(digest.html).toContain('href="https://www.intern-list.com/x/role_1"');
  });
});

describe('the technical digest is left alone', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('keeps its sponsorship sections and its score order', async () => {
    vi.resetModules();
    vi.stubEnv('JOB_PROFILE', '');
    const { buildDigest } = await import('../src/digest.js');
    const digest = buildDigest([
      role({ title: 'Low score but posted today', category: 'SWE', sponsorshipStatus: 'SUPPORTED', postedAt: '2026-08-20T00:00:00.000Z', score: 10 }),
      role({ title: 'High score posted long ago', company: 'Other', category: 'SWE', sponsorshipStatus: 'SUPPORTED', postedAt: '2026-06-01T00:00:00.000Z', score: 120 })
    ], []);
    expect(digest.html).toContain('<h2>Strong Summer 2027 matches</h2>');
    expect(digest.text.indexOf('High score posted long ago')).toBeLessThan(digest.text.indexOf('Low score but posted today'));
  });
});

describe('a Workday posting date', () => {
  const now = '2026-08-20T18:30:00.000Z';

  it('reads the prose Workday writes instead of a date', () => {
    expect(parseWorkdayPostedOn('Posted Today', now)).toBe('2026-08-20T00:00:00.000Z');
    expect(parseWorkdayPostedOn('Posted Yesterday', now)).toBe('2026-08-19T00:00:00.000Z');
    expect(parseWorkdayPostedOn('Posted 5 Days Ago', now)).toBe('2026-08-15T00:00:00.000Z');
    // "30+" is a floor, so it is read as exactly 30 days: the role sorts to the
    // bottom on either reading.
    expect(parseWorkdayPostedOn('Posted 30+ Days Ago', now)).toBe('2026-07-21T00:00:00.000Z');
  });

  it('answers undefined rather than a date it cannot justify', () => {
    for (const value of ['Posted recently', '', undefined, null, 42, 'Posted Last Week']) {
      expect(parseWorkdayPostedOn(value, now), String(value)).toBeUndefined();
    }
  });

  it('keeps an unreadable value out of postedAt entirely', () => {
    expect(isoOrUndefined('2026-08-20T12:00:00.000Z')).toBe('2026-08-20T12:00:00.000Z');
    expect(isoOrUndefined('Posted 30+ Days Ago')).toBeUndefined();
    expect(isoOrUndefined(undefined)).toBeUndefined();
  });
});

describe('a summary read off a board', () => {
  it('reads as prose, not as the markup the board encoded it in', async () => {
    const { shortSummary } = await import('../src/pipeline.js');
    // Greenhouse's own wire format. Undecoded, the tag stripper found no tags
    // and the digest escaped the ampersands again, so every board row's summary
    // read "&lt;p&gt;&lt;span style=..." in the email.
    const greenhouse = '&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;Chicago Trading Company (CTC) is a premier proprietary trading firm.&lt;/p&gt;&amp;nbsp;';
    const summary = shortSummary(greenhouse);
    expect(summary).toBe('Chicago Trading Company (CTC) is a premier proprietary trading firm.');
    expect(summary).not.toContain('&lt;');
    expect(summary).not.toContain('<');
  });

  it('still strips real tags, and still admits when there was nothing to read', async () => {
    const { shortSummary } = await import('../src/pipeline.js');
    expect(shortSummary('<p>Join our <strong>equity research</strong> team.</p>')).toBe('Join our equity research team.');
    expect(shortSummary('')).toBe('The source did not provide a verifiable description summary.');
  });
});

describe('the cap and the email agree on what matters', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('keeps the newest roles for finance, not the highest-scoring ones', async () => {
    // A run finds around 800 eligible roles against a cap of 100. When the cap
    // ranked by score and the email then sorted by date, "newest first" was
    // cosmetic: a role posted this morning lost its place to a better-scoring
    // one from three weeks ago and never appeared at all.
    vi.resetModules();
    vi.stubEnv('JOB_PROFILE', 'finance');
    vi.stubEnv('FINANCE_EMAIL_TO', 'someone@example.edu');
    const { diversifiedTop } = await import('../src/pipeline.js');
    const jobs = [
      role({ company: 'Old But Strong', title: 'Old But Strong', postedAt: '2026-07-30T00:00:00.000Z', score: 200 }),
      role({ company: 'Posted Today', title: 'Posted Today', postedAt: '2026-08-20T00:00:00.000Z', score: 10 })
    ];
    expect(diversifiedTop(jobs, 1).map(job => job.company)).toEqual(['Posted Today']);
  });

  it('still keeps the highest-scoring roles for the technical digest', async () => {
    vi.resetModules();
    vi.stubEnv('JOB_PROFILE', '');
    const { diversifiedTop } = await import('../src/pipeline.js');
    const jobs = [
      role({ company: 'Old But Strong', title: 'Old But Strong', postedAt: '2026-07-30T00:00:00.000Z', score: 200 }),
      role({ company: 'Posted Today', title: 'Posted Today', postedAt: '2026-08-20T00:00:00.000Z', score: 10 })
    ];
    expect(diversifiedTop(jobs, 1).map(job => job.company)).toEqual(['Old But Strong']);
  });
});

describe('the order the reader sees', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('sorts on the printed day, not the underlying instant', async () => {
    // The two kinds of value print in different zones: a list that dates by the
    // day writes midnight UTC and prints in UTC, a board that dates to the
    // second prints in Pacific. So a row printed "Aug 20, 10:39 PM" holds a
    // later instant than one printed "Aug 21", and sorting on the instant put
    // it first, which reads as broken to anyone looking at the dates.
    vi.resetModules();
    vi.stubEnv('JOB_PROFILE', 'finance');
    vi.stubEnv('FINANCE_EMAIL_TO', 'someone@example.edu');
    const { buildDigest } = await import('../src/digest.js');
    const digest = buildDigest([
      role({ company: 'Timestamped', title: 'Timestamped', postedAt: '2026-08-21T05:39:00.000Z' }),
      role({ company: 'DateOnly', title: 'DateOnly', postedAt: '2026-08-21T00:00:00.000Z' })
    ], []);
    // Both print as their own day; the one printing the later day comes first.
    expect(digest.text).toContain('Posted: Aug 21, 2026');
    expect(digest.text.indexOf('DateOnly')).toBeLessThan(digest.text.indexOf('Timestamped'));
  });

  it('still puts a genuinely older role below a newer one', async () => {
    vi.resetModules();
    vi.stubEnv('JOB_PROFILE', 'finance');
    vi.stubEnv('FINANCE_EMAIL_TO', 'someone@example.edu');
    const { buildDigest } = await import('../src/digest.js');
    const digest = buildDigest([
      role({ company: 'Older', title: 'Older', postedAt: '2026-07-30T00:00:00.000Z', score: 200 }),
      role({ company: 'Newer', title: 'Newer', postedAt: '2026-08-21T00:00:00.000Z', score: 10 })
    ], []);
    expect(digest.text.indexOf('Newer')).toBeLessThan(digest.text.indexOf('Older'));
  });
});
