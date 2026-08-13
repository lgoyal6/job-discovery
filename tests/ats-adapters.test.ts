import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtsSource, type AtsConfig } from '../src/sources/ats.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const leverJob = (id: number) => ({ id: `lever-${id}`, text: `Software Intern ${id}`, hostedUrl: `https://jobs.lever.co/acme/${id}`, applyUrl: `https://jobs.lever.co/acme/${id}/apply`, categories: { location: 'Remote', commitment: 'Intern' }, descriptionPlain: 'TypeScript internship' });
const smartJob = (id: number) => ({ id: `smart-${id}`, name: `Data Intern ${id}`, ref: `https://jobs.smartrecruiters.com/Acme/${id}`, location: { city: 'San Diego', region: 'CA', country: 'US' } });
const workdayJob = (id: number) => ({ id: `workday-${id}`, title: `Platform Intern ${id}`, externalPath: `/job/${id}`, bulletFields: [`R-${id}`], locationsText: 'California', postedOn: '2026-08-01' });

describe('ATS adapters', () => {
  it('dates a Greenhouse posting from first publication, not the last board edit', async () => {
    // IMC's July 1 internships carried updated_at of two days ago, so a
    // six-week-old listing was reported to the digest as posted this week.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      jobs: [{ id: 1, title: 'Software Engineer Intern - Summer 2027', absolute_url: 'https://boards.greenhouse.io/imc/jobs/1', location: { name: 'Chicago, United States' }, first_published: '2026-07-01T13:11:54-04:00', updated_at: '2026-08-10T02:34:58-04:00' }]
    }), { status: 200 })));
    const result = await new AtsSource({ type: 'greenhouse', board: 'imc', company: 'IMC' }).fetch();
    expect(result.jobs[0]?.postedAt).toBe('2026-07-01T13:11:54-04:00');
  });

  it('paginates Lever until the first short page', async () => {
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => leverJob(index))), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([leverJob(100)]), { status: 200 }));
    vi.stubGlobal('fetch', mockedFetch);
    const result = await new AtsSource({ type: 'lever', site: 'acme', company: 'Acme' }).fetch();
    expect(result.status).toBe('SUCCESS');
    expect(result.jobs).toHaveLength(101);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(String(mockedFetch.mock.calls[1]?.[0])).toContain('skip=100');
  });

  it('paginates SmartRecruiters and Workday with their native request shapes', async () => {
    const smartFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: Array.from({ length: 100 }, (_, index) => smartJob(index)), totalFound: 101 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [smartJob(100)], totalFound: 101 }), { status: 200 }));
    vi.stubGlobal('fetch', smartFetch);
    const smart = await new AtsSource({ type: 'smartrecruiters', companyId: 'Acme', company: 'Acme' }).fetch();
    expect(smart.jobs).toHaveLength(101);
    expect(String(smartFetch.mock.calls[1]?.[0])).toContain('offset=100');

    const workdayFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobPostings: Array.from({ length: 100 }, (_, index) => workdayJob(index)) }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobPostings: [workdayJob(100)] }), { status: 200 }));
    vi.stubGlobal('fetch', workdayFetch);
    const workday = await new AtsSource({ type: 'workday', host: 'https://acme.wd5.myworkdayjobs.com', tenant: 'acme', site: 'External', company: 'Acme' }).fetch();
    expect(workday.jobs).toHaveLength(101);
    const secondBody = JSON.parse(String((workdayFetch.mock.calls[1]?.[1] as RequestInit).body));
    expect(secondBody).toMatchObject({ offset: 100, limit: 100, searchText: '' });
  });

  it.each(['icims', 'oracle', 'successfactors', 'eightfold', 'career-page'] as const)('normalizes generic %s endpoints', async type => {
    const mockedFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jobs: [{ id: `${type}-1`, title: 'Security Engineering Intern', location: 'Remote', datePosted: '2026-08-01', jobDescription: 'Python security engineering', externalUrl: `https://careers.test/${type}/1` }] }), { status: 200 }));
    vi.stubGlobal('fetch', mockedFetch);
    const cfg: AtsConfig = { type, company: 'Acme', endpoint: `https://api.test/${type}` };
    const result = await new AtsSource(cfg).fetch();
    expect(result).toMatchObject({ status: 'SUCCESS' });
    expect(result.jobs[0]).toMatchObject({ sourceJobId: `${type}-1`, company: 'Acme', title: 'Security Engineering Intern', directApplyUrl: `https://careers.test/${type}/1` });
  });

  it('reports schema drift as one failed source instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ unexpected: true }), { status: 200 })));
    const result = await new AtsSource({ type: 'greenhouse', board: 'broken', company: 'Broken' }).fetch();
    expect(result.status).toBe('FAILED');
    expect(result.jobs).toEqual([]);
    expect(result.error).toContain('Invalid input');
  });
});
