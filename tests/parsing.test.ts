import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseHtmlJobs, parseMarkdownJobs, parsePostedAt } from '../src/sources/community.js';
import { normalizeAshby, normalizeGreenhouse, normalizeLever, normalizeSmartRecruiters } from '../src/sources/ats.js';
import { normalizeApifyItems } from '../src/sources/apify.js';

const fixture = (name: string) => readFile(resolve(process.cwd(), 'fixtures', name), 'utf8').then(JSON.parse);

describe('community list posting dates', () => {
  const now = '2026-08-12T20:00:00Z';

  it('reads both the absolute and the relative form each list uses', () => {
    // vanshb03 writes "Jul 31"; Simplify and speedyapply write "9d" and "1mo".
    expect(parsePostedAt('Jul 31', now)?.slice(0, 10)).toBe('2026-07-31');
    expect(parsePostedAt('Aug 04', now)?.slice(0, 10)).toBe('2026-08-04');
    expect(parsePostedAt('9d', now)?.slice(0, 10)).toBe('2026-08-03');
    expect(parsePostedAt('0d', now)?.slice(0, 10)).toBe('2026-08-12');
    expect(parsePostedAt('1mo', now)?.slice(0, 10)).toBe('2026-07-13');
  });

  it('reads a bare month and day as the most recent one, not a future date', () => {
    expect(parsePostedAt('Dec 18', '2027-01-05T00:00:00Z')?.slice(0, 10)).toBe('2026-12-18');
  });

  it('leaves anything that is not a date alone', () => {
    for (const cell of ['', '$72/hr', 'Apply', 'Closed', 'Xyz 40']) {
      expect(parsePostedAt(cell, now)).toBeUndefined();
    }
  });

  it('dates a row from its last column without eating the salary column', () => {
    // Castleton's full-stack internship reached the digest reading "First seen
    // today" while its Simplify row had said 23d all along.
    const speedyapply = ['| Company | Position | Location | Salary | Posting | Age |',
      '| ---- | ---- | ---- | ---- | ---- | ---- |',
      '| [Figma](https://figma.com) | Software Engineer Intern | SF, CA | $60/hr | [Apply](https://boards.greenhouse.io/figma/jobs/6131089004) | 9d |'].join('\n');
    const [job] = parseMarkdownJobs(speedyapply, { name: 'speedyapply', url: 'https://example.com/feed' }, now);
    expect(job?.postedAt?.slice(0, 10)).toBe('2026-08-03');
    expect(job?.description).toContain('$60/hr');
    expect(job?.description).not.toContain('9d');
  });

  it('keeps the last column in the description when it is not a date', () => {
    const markdown = ['| Company | Role | Location | Link | Notes |',
      '| ---- | ---- | ---- | ---- | ---- |',
      '| Acme | Software Engineer Intern | Remote | [Apply](https://boards.greenhouse.io/acme/jobs/1) | Requires C++ |'].join('\n');
    const [job] = parseMarkdownJobs(markdown, { name: 'list', url: 'https://example.com/feed' }, now);
    expect(job?.postedAt).toBeUndefined();
    expect(job?.description).toContain('Requires C++');
  });
});

describe('source parsers', () => {
  it('parses Markdown tables, inherited companies, direct URLs, and skips closed rows', async () => {
    const markdown = await readFile(resolve(process.cwd(), 'fixtures/community.md'), 'utf8');
    const jobs = parseMarkdownJobs(markdown, { name: 'fixture', url: 'https://example.com/feed', cycle: 'Summer 2027' }, '2026-08-04T00:00:00Z');
    expect(jobs).toHaveLength(2);
    expect(jobs[1]?.company).toBe('Acme');
    expect(jobs[0]?.directApplyUrl).toContain('greenhouse.io');
  });

  // Both regressions below shipped silently: the sources returned 200 with a
  // full document, parsed to zero rows, and reported SUCCESS for over a day.
  it('parses table cells that use raw <a> tags instead of Markdown links', () => {
    const markdown = [
      '| Company | Role | Location | Application |',
      '| --- | --- | --- | --- |',
      '| <a href="https://www.tiktok.com"><strong>TikTok</strong></a> | Fullstack SWE Intern | Seattle, WA | <a href="https://lifeattiktok.com/search/7670700387322300677">Apply</a> |'
    ].join('\n');
    const jobs = parseMarkdownJobs(markdown, { name: 'fixture', url: 'https://example.com/feed' }, '2026-08-07T00:00:00Z');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.company).toBe('TikTok');
    expect(jobs[0]?.directApplyUrl).toContain('lifeattiktok.com');
  });

  // Simplify's apply buttons are <img alt="Apply"> anchors. Stripping the tag
  // erased the label, so the selector fell back to the row's first link — the
  // company profile — for every top-level row (155/284 live rows on 2026-08-10).
  it('reads the apply label from image-button anchors instead of shipping the company profile', () => {
    const html = [
      '<table><tbody><tr>',
      '<td>🔥 <strong><a href="https://simplify.jobs/c/TikTok?utm_source=GHList&utm_medium=company">TikTok</a></strong></td>',
      '<td>Software Engineer Intern - Global E-commerce-Search</td><td>San Jose, CA</td>',
      '<td><div align="center"><a href="https://lifeattiktok.com/search/7670839727059339525?utm_source=Simplify&ref=Simplify"><img src="https://i.imgur.com/fbjwDvo.png" width="50" alt="Apply"></a> ',
      '<a href="https://simplify.jobs/p/d1768aee-f240-4353-b609-278b04785c95?utm_source=GHList"><img src="https://i.imgur.com/aVnQdox.png" width="26" alt="Simplify"></a></div></td>',
      '</tr></tbody></table>'
    ].join('');
    const jobs = parseMarkdownJobs(html, { name: 'fixture', url: 'https://example.com/feed' }, '2026-08-10T00:00:00Z');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.company).toBe('TikTok');
    expect(jobs[0]?.directApplyUrl).toContain('lifeattiktok.com/search/7670839727059339525');
  });

  it('never falls back to a simplify.jobs/c/ company profile while the row has another link', () => {
    const html = [
      '<table><tbody><tr>',
      '<td><a href="https://simplify.jobs/c/Acme">Acme</a></td>',
      '<td>SWE Intern</td><td>NYC</td>',
      // No recognizable apply label at all: the posting link must still win.
      '<td><a href="https://boards.greenhouse.io/acme/jobs/4400"><img src="https://i.imgur.com/x.png"></a></td>',
      '</tr></tbody></table>'
    ].join('');
    const jobs = parseMarkdownJobs(html, { name: 'fixture', url: 'https://example.com/feed' }, '2026-08-10T00:00:00Z');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.directApplyUrl).toBe('https://boards.greenhouse.io/acme/jobs/4400');
    expect(jobs[0]?.sourceJobId).toBe('4400');
  });

  it('falls back to <tr>/<td> rows when the pipe table is gone, and drops marker emoji', () => {
    const html = [
      '<table><thead><tr><th>Company</th><th>Role</th><th>Location</th></tr></thead><tbody>',
      '<tr><td>🔥 <strong><a href="https://simplify.jobs/c/Stripe">Stripe</a></strong></td>',
      '<td>Software Engineer Intern</td><td>NYC</td>',
      '<td><a href="https://boards.greenhouse.io/stripe/jobs/123">Apply</a></td></tr>',
      '</tbody></table>'
    ].join('');
    const jobs = parseMarkdownJobs(html, { name: 'fixture', url: 'https://example.com/feed' }, '2026-08-07T00:00:00Z');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.company).toBe('Stripe');
    expect(jobs[0]?.location).toBe('NYC');
  });

  it('normalizes Greenhouse, Lever, Ashby and SmartRecruiters schemas', async () => {
    const now = '2026-08-04T00:00:00Z';
    expect(normalizeGreenhouse(await fixture('greenhouse.json'), { type: 'greenhouse', board: 'acme', company: 'Acme' }, now)[0]?.sourceJobId).toBe('123');
    expect(normalizeLever(await fixture('lever.json'), { type: 'lever', site: 'acme', company: 'Acme' }, now)[0]?.employmentType).toBe('Intern');
    expect(normalizeAshby(await fixture('ashby.json'), { type: 'ashby', board: 'acme', company: 'Acme' }, now)[0]?.directApplyUrl).toContain('application');
    expect(normalizeSmartRecruiters(await fixture('smartrecruiters.json'), { type: 'smartrecruiters', companyId: 'Acme', company: 'Acme' }, now)[0]?.location).toBe('San Diego, CA, US');
  });

  it('normalizes heterogeneous Apify LinkedIn/Indeed/Monster actor results', async () => {
    const jobs = normalizeApifyItems(await fixture('apify.json'), 'linkedin', '2026-08-04T00:00:00Z');
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ sourceJobId: 'li-123', company: 'Acme' });
    expect(jobs[1]?.directApplyUrl).toBe('https://beta.com/careers/456');
  });

  it('applies to the posting, not to the company website', () => {
    // jobright links the company name to the company's own site and the role to
    // the posting, and labels neither "apply". The fallback used to take the
    // first link in column order, so every row off both finance lists arrived
    // pointing at pimco.com or capitalone.com. It also collapsed identity: one
    // company website is one canonical URL, so every role there became one row.
    const jobright = ['| Company | Job Title | Location | Work Model | Date Posted |',
      '| ----- | --------- | --------- | ---- | ------- |',
      '| **[Specsavers](https://www.specsavers.co.uk)** | **[Commercial Finance Intern](https://jobright.ai/jobs/info/6a85ddc02f4f0014cae268d6?utm_campaign=1052&utm_source=git)** | Burnaby, BC | Hybrid | Aug 19 |'].join('\n');
    const [job] = parseMarkdownJobs(jobright, { name: 'jobright-finance-internship', url: 'https://example.com/readme' }, '2026-08-19T00:00:00Z');
    expect(job?.directApplyUrl).toBe('https://jobright.ai/jobs/info/6a85ddc02f4f0014cae268d6?utm_campaign=1052&utm_source=git');
    expect(job?.company).toBe('Specsavers');
  });

  it('still prefers a labelled apply link over the role cell', () => {
    // Simplify and speedyapply put the ATS link in its own column with an
    // "Apply" label, which outranks the role cell's own link.
    const simplify = ['| Company | Role | Location | Application | Age |',
      '| ---- | ---- | ---- | ---- | ---- |',
      '| [Acme](https://simplify.jobs/c/acme) | [SWE Intern](https://simplify.jobs/p/abc123) | NYC | [Apply](https://boards.greenhouse.io/acme/jobs/456) | 3d |'].join('\n');
    const [job] = parseMarkdownJobs(simplify, { name: 'simplify-summer', url: 'https://example.com/readme' }, '2026-08-19T00:00:00Z');
    expect(job?.directApplyUrl).toBe('https://boards.greenhouse.io/acme/jobs/456');
  });

  it('extracts unique direct job links from HTML feeds', () => {
    const html = '<section>Acme Software Internship <a href="https://jobs.lever.co/acme/123">Apply for job</a></section><a href="https://jobs.lever.co/acme/123">duplicate</a>';
    const jobs = parseHtmlJobs(html, { name: 'html-feed', url: 'https://feed.test', cycle: 'Summer 2027' }, '2026-08-04T00:00:00Z');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ sourceName: 'html-feed', directApplyUrl: 'https://jobs.lever.co/acme/123', cycleHint: 'Summer 2027' });
  });
});
