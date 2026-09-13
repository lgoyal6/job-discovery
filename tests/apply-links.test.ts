import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DigestJob } from '../src/types.js';

const row = (title: string, company: string, url: string): DigestJob =>
  ({ title, company, directApplyUrl: url, canonicalUrl: url } as unknown as DigestJob);

// zapplyjobs' redirector now lands every slug on Zapply's own listings page.
// The Workday slugs it leaves behind name the tenant, the career site and the
// requisition but not the host number, and spell the site lower-case with
// hyphens for its underscores.
describe('zapplyjobs Workday slugs', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads tenant, site and requisition off the slug however the requisition is written', async () => {
    const { parseZapplyWorkday } = await import('../src/apply-links.js');
    expect(parseZapplyWorkday('https://zapply.jobs/l/d/workday-nvidia-nvidiaexternalcareersite-JR2025245?s=gh-internships-2027'))
      .toEqual({ tenant: 'nvidia', site: 'nvidiaexternalcareersite', requisition: 'JR2025245' });
    expect(parseZapplyWorkday('https://zapply.jobs/l/d/workday-td-td-bank-careers-R_1509773'))
      .toEqual({ tenant: 'td', site: 'td-bank-careers', requisition: 'R_1509773' });
    expect(parseZapplyWorkday('https://zapply.jobs/l/d/workday-nxp-careers-R-10064679'))
      .toEqual({ tenant: 'nxp', site: 'careers', requisition: 'R-10064679' });
    // A lower-case word before the number is the end of the site, not a requisition prefix.
    expect(parseZapplyWorkday('https://zapply.jobs/l/d/workday-vanguard-vanguard-external-181764'))
      .toEqual({ tenant: 'vanguard', site: 'vanguard-external', requisition: '181764' });
    // Requisitions with a second number group belong together; the site has no digits to claim them.
    expect(parseZapplyWorkday('https://zapply.jobs/l/d/workday-insulet-insuletcareers-REQ-2026-18071?s=gh-internships-2027'))
      .toEqual({ tenant: 'insulet', site: 'insuletcareers', requisition: 'REQ-2026-18071' });
    expect(parseZapplyWorkday('https://zapply.jobs/l/d/workday-tel-tel-careers-R26-01519'))
      .toEqual({ tenant: 'tel', site: 'tel-careers', requisition: 'R26-01519' });
    expect(parseZapplyWorkday('https://zapply.jobs/l/d/workday-harman-harman-R-55479-2026'))
      .toEqual({ tenant: 'harman', site: 'harman', requisition: 'R-55479-2026' });
    expect(parseZapplyWorkday('https://zapply.jobs/l/d/greenhouse-lyft-8797837002')).toBeUndefined();
    expect(parseZapplyWorkday('https://bah.wd1.myworkdayjobs.com/BAH_Jobs/job/x_R0249225')).toBeUndefined();
    expect(parseZapplyWorkday(undefined)).toBeUndefined();
  });

  it('finds the posting on the host that answers and remembers that host for the tenant', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      calls.push(input);
      const url = new URL(input);
      // The tenant lives on wd5 under BAH_Jobs; every other host number and the
      // hyphenated spelling are wrong guesses, and answer the way Workday does.
      if (url.hostname !== 'bah.wd5.myworkdayjobs.com') return new Response('', { status: 422 });
      if (!url.pathname.startsWith('/wday/cxs/bah/bah_jobs/jobs')) return new Response('', { status: 404 });
      const { searchText } = JSON.parse(String(init?.body)) as { searchText: string };
      // Workday numbers the posting after the requisition in the path, here the first posting of R0249225.
      const postings = searchText === 'R0249225'
        ? [{ title: 'University - Summer 2027, Software Engineer Intern', externalPath: '/job/Fayetteville-NC/University---Summer-2027--Software-Engineer-Intern_R0249225-1' }]
        : [];
      return new Response(JSON.stringify({ total: postings.length, jobPostings: postings }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const { resolveListingLinks } = await import('../src/apply-links.js');
    const jobs = [
      row('Software Engineer Intern', 'Booz Allen Hamilton', 'https://zapply.jobs/l/d/workday-bah-bah-jobs-R0249225?s=gh-internships-2027'),
      row('Data Science Intern', 'Booz Allen Hamilton', 'https://zapply.jobs/l/d/workday-bah-bah-jobs-R0000001')
    ];
    const outcome = await resolveListingLinks(jobs);
    expect(outcome).toEqual({ attempted: 2, resolved: 1 });
    expect(jobs[0]?.directApplyUrl).toBe('https://bah.wd5.myworkdayjobs.com/bah_jobs/job/Fayetteville-NC/University---Summer-2027--Software-Engineer-Intern_R0249225-1');
    // The second row is not on the board, so its link is left as it was rather than pointed at the wrong job.
    expect(jobs[1]?.directApplyUrl).toBe('https://zapply.jobs/l/d/workday-bah-bah-jobs-R0000001');
    // wd1 in both spellings, then wd5 underscored, which answered; the second row asks that host once.
    expect(calls.filter(call => call.includes('myworkdayjobs.com')).map(call => new URL(call).host + new URL(call).pathname)).toEqual([
      'bah.wd1.myworkdayjobs.com/wday/cxs/bah/bah_jobs/jobs',
      'bah.wd1.myworkdayjobs.com/wday/cxs/bah/bah-jobs/jobs',
      'bah.wd5.myworkdayjobs.com/wday/cxs/bah/bah_jobs/jobs',
      'bah.wd5.myworkdayjobs.com/wday/cxs/bah/bah_jobs/jobs'
    ]);
  });
});
