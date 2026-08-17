import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtsSource, normalizeGreenhouse, type AtsConfig } from '../src/sources/ats.js';

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

  it('keeps a Greenhouse board whose posting has a null first_published', async () => {
    // Two null rows on towerresearchcapital failed the array parse and took all
    // 79 postings with them. The dated rows must survive, and the undated one
    // must fall back to updated_at rather than killing its board.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      jobs: [
        { id: 1, title: 'Quant Intern', absolute_url: 'https://boards.greenhouse.io/trc/jobs/1', location: { name: 'New York' }, first_published: '2026-07-01T13:11:54-04:00', updated_at: '2026-08-10T02:34:58-04:00' },
        { id: 2, title: 'Software Intern', absolute_url: 'https://boards.greenhouse.io/trc/jobs/2', location: { name: 'New York' }, first_published: null, updated_at: '2026-07-24T15:05:09-04:00' }
      ]
    }), { status: 200 })));
    const result = await new AtsSource({ type: 'greenhouse', board: 'trc', company: 'Tower Research' }).fetch();
    expect(result.status).toBe('SUCCESS');
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs[0]?.postedAt).toBe('2026-07-01T13:11:54-04:00');
    expect(result.jobs[1]?.postedAt).toBe('2026-07-24T15:05:09-04:00');
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

  // 93 Greenhouse boards answered with no description at all, so a title with
  // no year had no cycle and was dropped. Descriptions are back, but only for
  // the postings a rule will read: Anduril's board is 38 MB and keeping all of
  // it would put ~300 MB through a run to classify a few hundred student roles.
  it('keeps a Greenhouse description for a student title and discards the rest', async () => {
    const board = { jobs: [
      { id: 1, title: 'Gameplay Programmer Intern', absolute_url: 'https://boards.greenhouse.io/epicgames/jobs/1', location: { name: 'Cary, NC' }, first_published: '2026-08-12T00:00:00Z', content: 'Summer 2027 gameplay work in C++' },
      { id: 2, title: 'Senior Staff Engineer', absolute_url: 'https://boards.greenhouse.io/epicgames/jobs/2', location: { name: 'Cary, NC' }, first_published: '2026-08-12T00:00:00Z', content: 'x'.repeat(20_000) }
    ] };
    const jobs = normalizeGreenhouse(board, { type: 'greenhouse', board: 'epicgames', company: 'Epic Games' }, new Date().toISOString());
    expect(jobs[0]?.description).toContain('Summer 2027');
    expect(jobs[1]?.description).toBeUndefined();
  });

  // Oracle Recruiting nests its postings inside items[0].requisitionList, beside
  // the search metadata that produced them. The generic reader takes `items`
  // itself, finds one titleless object, and drops it, which is why American
  // Express and its 56 student postings were invisible.
  it('reads Oracle requisitions out of the search wrapper, and pages them', async () => {
    const page = (ids: number[], count: number): Response => new Response(JSON.stringify({
      items: [{ TotalJobsCount: count, requisitionList: ids.map(id => ({
        Id: String(id), Title: 'Campus Undergraduate Summer Internship Program - 2027 Software Engineer',
        PrimaryLocation: 'Charlotte, NC, United States', PostedDate: '2026-08-17',
        ShortDescriptionStr: 'Join the team', ExternalQualificationsStr: 'Python and Java'
      })) }]
    }), { status: 200 });
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(page(Array.from({ length: 200 }, (_, index) => 26010000 + index), 250))
      .mockResolvedValueOnce(page([26011679], 250));
    vi.stubGlobal('fetch', mockedFetch);

    const result = await new AtsSource({ type: 'oracle', host: 'https://egug.fa.us2.oraclecloud.com', site: 'CX_1', company: 'American Express' }).fetch();
    expect(result.status).toBe('SUCCESS');
    expect(result.jobs).toHaveLength(201);
    // The name the run reports must equal the name stamped on its jobs, or the
    // pipeline attributes every posting to no source and reports 0 accepted.
    expect(result.sourceName).toBe('oracle:american-express');
    expect(new Set(result.jobs.map(job => job.sourceName))).toEqual(new Set(['oracle:american-express']));
    expect(result.jobs[200]).toMatchObject({
      sourceJobId: '26011679', company: 'American Express',
      directApplyUrl: 'https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26011679'
    });
    // Qualifications carry the citizenship sentence far more often than the
    // summary does, so all three prose fields have to reach the classifier.
    expect(result.jobs[0]?.description).toContain('Python and Java');
    expect(result.jobs[0]?.postedAt).toBe('2026-08-17T00:00:00.000Z');
    const [firstUrl] = mockedFetch.mock.calls[0] as [string];
    expect(decodeURIComponent(firstUrl)).toContain('findReqs;siteNumber=CX_1');
    expect(firstUrl).toContain('expand=requisitionList');
  });

  it.each(['icims', 'successfactors', 'eightfold', 'career-page'] as const)('normalizes generic %s endpoints', async type => {
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
