import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseHtmlJobs, parseMarkdownJobs } from '../src/sources/community.js';
import { normalizeAshby, normalizeGreenhouse, normalizeLever, normalizeSmartRecruiters } from '../src/sources/ats.js';
import { normalizeApifyItems } from '../src/sources/apify.js';

const fixture = (name: string) => readFile(resolve(process.cwd(), 'fixtures', name), 'utf8').then(JSON.parse);

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

  it('extracts unique direct job links from HTML feeds', () => {
    const html = '<section>Acme Software Internship <a href="https://jobs.lever.co/acme/123">Apply for job</a></section><a href="https://jobs.lever.co/acme/123">duplicate</a>';
    const jobs = parseHtmlJobs(html, { name: 'html-feed', url: 'https://feed.test', cycle: 'Summer 2027' }, '2026-08-04T00:00:00Z');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ sourceName: 'html-feed', directApplyUrl: 'https://jobs.lever.co/acme/123', cycleHint: 'Summer 2027' });
  });
});
