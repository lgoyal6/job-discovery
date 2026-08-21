import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InternListSource, parseDetailPage, parseListPage, parseListedDate } from '../src/sources/intern-list.js';

const fixture = (name: string) => readFile(resolve(process.cwd(), 'fixtures', name), 'utf8');
const LIST_URL = 'https://www.intern-list.com/swe-intern-list';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('intern-list list page', () => {
  it('reads the rows the generic HTML reader was blind to', async () => {
    // Both lists reported SUCCESS on every run while contributing nothing: the
    // rows are root-relative hrefs and the generic reader only matched absolute
    // ones, so all it ever returned were three site promos.
    const { rows } = parseListPage(await fixture('intern-list.html'), LIST_URL);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      company: 'RTX',
      title: '2027 Software Engineer Intern (Onsite)',
      url: `${LIST_URL}/2027_software_engineer_intern_onsite__at_rtx_87811882`
    });
    expect(rows[0]?.postedAt?.slice(0, 10)).toBe('2026-08-18');
  });

  it('follows the pagination link rather than building the query itself', async () => {
    // e3be0bc2_page is a Webflow collection id, not a stable parameter name.
    const { nextUrl } = parseListPage(await fixture('intern-list.html'), LIST_URL);
    expect(nextUrl).toBe(`${LIST_URL}?e3be0bc2_page=2`);
  });

  it('dates a row from the year the page states', () => {
    expect(parseListedDate('August 18, 2026')?.slice(0, 10)).toBe('2026-08-18');
    expect(parseListedDate('May 28, 2026')?.slice(0, 10)).toBe('2026-05-28');
    for (const value of ['', 'August 2026', 'Aug 18', '9d', 'Onsite']) expect(parseListedDate(value)).toBeUndefined();
  });
});

describe('intern-list posting page', () => {
  it('reads the location chip and stops the description at the Glassdoor card', async () => {
    const detail = parseDetailPage(await fixture('intern-list-detail.html'));
    expect(detail.location).toBe('Seattle, WA');
    expect(detail.description).toContain('Pursuing graduation in a Computer Science');
    // The chips run location, employment type, work mode, pay, level. Only the
    // first is a location, and the company blurb past the Glassdoor card is not
    // about this posting at all.
    expect(detail.description).not.toContain('Founded in 1993');
  });
});

describe('intern-list source', () => {
  const serve = (responses: Array<[RegExp, () => Response]>) => vi.fn((input: string | URL) => {
    const url = String(input);
    const match = responses.find(([pattern]) => pattern.test(url));
    return Promise.resolve(match ? match[1]() : new Response('not found', { status: 404 }));
  });

  it('gives every row it emits a location read the same way', async () => {
    const [list, detail] = await Promise.all([fixture('intern-list.html'), fixture('intern-list-detail.html')]);
    vi.stubGlobal('fetch', serve([
      [/page=2$/, () => new Response('<div class="collection-list w-dyn-items"></div>')],
      [/swe-intern-list\/[a-z0-9_]+$/, () => new Response(detail)],
      [/swe-intern-list$/, () => new Response(list)]
    ]));

    const result = await new InternListSource({ name: 'intern-list-swe', url: LIST_URL }).fetch();
    expect(result.status).toBe('SUCCESS');
    expect(result.jobs).toHaveLength(3);
    expect(result.jobs.every(job => job.location === 'Seattle, WA')).toBe(true);
    expect(result.jobs[0]).toMatchObject({
      sourceName: 'intern-list-swe',
      sourceUrl: `${LIST_URL}/2027_software_engineer_intern_onsite__at_rtx_87811882`
    });
    // No direct apply URL. This page is the list's own write-up and its apply
    // button leads to a jobright.ai account wall rather than to the employer,
    // so offering the same URL a second time as a "direct application" promised
    // a link that does not exist.
    expect(result.jobs[0]?.directApplyUrl).toBeUndefined();
    // The trailing number in the slug is this site's row id, not the employer's
    // requisition id, and localDedupe's req: key is scoped by company rather
    // than by source.
    expect(result.jobs[0]?.sourceJobId).toBeUndefined();
  });

  it('drops a row whose page could not be read instead of emitting it flat', async () => {
    // materialFingerprint is title, location and cycle: one run without the
    // location and the next with it clears sent_at and mails the role again.
    const [list, detail] = await Promise.all([fixture('intern-list.html'), fixture('intern-list-detail.html')]);
    vi.stubGlobal('fetch', serve([
      [/page=2$/, () => new Response('<div class="collection-list w-dyn-items"></div>')],
      [/at_rtx_87811882$/, () => new Response('gone', { status: 404 })],
      [/swe-intern-list\/[a-z0-9_]+$/, () => new Response(detail)],
      [/swe-intern-list$/, () => new Response(list)]
    ]));

    const result = await new InternListSource({ name: 'intern-list-swe', url: LIST_URL }).fetch();
    expect(result.status).toBe('SUCCESS');
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.some(job => job.company === 'RTX')).toBe(false);
  });

  it('fails closed when the markup moves, rather than reporting an empty list', async () => {
    vi.stubGlobal('fetch', serve([[/./, () => new Response('<div class="collection-list w-dyn-items"></div>')]]));
    const result = await new InternListSource({ name: 'intern-list-swe', url: LIST_URL }).fetch();
    expect(result.status).toBe('FAILED');
    expect(result.error).toMatch(/parsed 0 rows/);
  });
});
