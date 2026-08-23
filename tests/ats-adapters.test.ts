import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtsSource, greenhousePostedAt, normalizeGreenhouse, type AtsConfig } from '../src/sources/ats.js';

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

    // Twenty a page, because Workday answers HTTP 400 with an empty message for
    // any limit above 20. Asking for a hundred failed every board on every
    // attempt: all ten investment managers reported FAILED on the first run
    // that configured one.
    const workdayFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobPostings: Array.from({ length: 20 }, (_, index) => workdayJob(index)) }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobPostings: [workdayJob(20)] }), { status: 200 }))
      // The searched sweep: one posting the blank sweep already returned, and
      // one it never reached.
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobPostings: [workdayJob(20), workdayJob(21)] }), { status: 200 }));
    vi.stubGlobal('fetch', workdayFetch);
    const workday = await new AtsSource({ type: 'workday', host: 'https://acme.wd5.myworkdayjobs.com', tenant: 'acme', site: 'External', company: 'Acme' }).fetch();
    const secondBody = JSON.parse(String((workdayFetch.mock.calls[1]?.[1] as RequestInit).body));
    expect(secondBody).toMatchObject({ offset: 20, limit: 20, searchText: '' });

    // Sony publishes 102 postings of which 62 are internships, so the newest
    // sixty are not where its students are. The second sweep asks the same
    // board for interns, which Workday ranks by relevance rather than date.
    const searched = JSON.parse(String((workdayFetch.mock.calls[2]?.[1] as RequestInit).body));
    expect(searched).toMatchObject({ offset: 0, searchText: 'intern' });
    // 21 from the blank sweep plus the one posting only the search found: the
    // requisition both sweeps returned must not become a second row.
    expect(workday.jobs).toHaveLength(22);
    expect(workday.jobs.filter(job => job.sourceJobId === 'R-20')).toHaveLength(1);
  });

  // Databricks lists a Summer 2027 internship whose requisition was first
  // published in August 2023 and edited four days ago, and the digest printed
  // "Aug 17, 2023" against a 2027 role.
  it('prefers first publication, unless the board is recycling a requisition', () => {
    const now = '2026-08-22T23:00:00Z';
    expect(greenhousePostedAt('2023-08-17T17:27:27-04:00', '2026-08-18T13:17:06-04:00', now)?.slice(0, 10)).toBe('2026-08-18');
    // IMC's July internships carried an updated_at of two days ago, so reading
    // the edit date reported a six-week-old listing as posted this week. That
    // is still the behaviour inside the window.
    expect(greenhousePostedAt('2026-07-01T00:00:00Z', '2026-08-20T00:00:00Z', now)?.slice(0, 10)).toBe('2026-07-01');
    expect(greenhousePostedAt(null, '2026-08-20T00:00:00Z', now)?.slice(0, 10)).toBe('2026-08-20');
    expect(greenhousePostedAt(null, null, now)).toBeUndefined();
  });

  // Phenom runs the careers site for a large slice of the Fortune 500 and its
  // search is one POST to /widgets. The payoff is that its rows already carry
  // the employer's own ATS link: Truist's 2027 technology internship comes back
  // pointing at truist.wd1.myworkdayjobs.com rather than at a search page.
  it('reads a Phenom board, and keeps the employer apply link it hands back', async () => {
    const job = (id: number, title: string) => ({
      jobId: `R011806${id}`, title, location: 'Charlotte, North Carolina, USA',
      postedDate: '2026-08-18T00:00:00.000+0000',
      applyUrl: `https://truist.wd1.myworkdayjobs.com/Careers/job/Charlotte-NC/x_R011806${id}`
    });
    const phenomFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ refineSearch: { totalHits: 2, data: { jobs: [job(1, '2027 Technology, Data, and Operations Internship')] } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ refineSearch: { totalHits: 2, data: { jobs: [job(1, '2027 Technology, Data, and Operations Internship'), job(2, 'Corporate Banking Analyst')] } } }), { status: 200 }));
    vi.stubGlobal('fetch', phenomFetch);
    const source = await new AtsSource({ type: 'phenom', host: 'careers.truist.com', company: 'Truist' }).fetch();

    // The searched sweep runs first, then the plain one, merged on requisition
    // id so the posting both return is one row.
    expect(JSON.parse(String((phenomFetch.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ keywords: 'intern', from: 0 });
    expect(JSON.parse(String((phenomFetch.mock.calls[1]?.[1] as RequestInit).body))).toMatchObject({ keywords: '' });
    expect(source.jobs).toHaveLength(2);
    expect(source.jobs.filter(j => j.sourceJobId === 'R0118061')).toHaveLength(1);

    const [first] = source.jobs;
    expect(first?.title).toBe('2027 Technology, Data, and Operations Internship');
    expect(first?.location).toBe('Charlotte, North Carolina, USA');
    expect(first?.postedAt?.slice(0, 10)).toBe('2026-08-18');
    expect(first?.directApplyUrl).toContain('truist.wd1.myworkdayjobs.com');
  });

  // Millennium's campus board is Eightfold, and Eightfold answers with ten
  // positions however many are asked for, so a single request saw six of its
  // 59 campus roles. Its 2027 quantitative internships are the reason the
  // board is configured, and they are not all in the first ten.
  it('pages through an Eightfold board and reads its own field names', async () => {
    const position = (id: number) => ({
      id: 700000 + id, name: `2027 Quantitative Researcher Intern ${id}`,
      location: 'New York, New York, United States of America',
      t_create: 1786320000, canonicalPositionUrl: `https://mlp.eightfold.ai/careers/job/${700000 + id}`
    });
    const eightfoldFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: 12, positions: Array.from({ length: 10 }, (_, i) => position(i)) }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: 12, positions: [position(10), position(11)] }), { status: 200 }));
    vi.stubGlobal('fetch', eightfoldFetch);
    const source = await new AtsSource({ type: 'eightfold', company: 'Millennium', endpoint: 'https://campusjobs.mlp.com/api/apply/v2/jobs?domain=mlp.com&start=0&num=100' }).fetch();

    expect(source.jobs).toHaveLength(12);
    expect(String(eightfoldFetch.mock.calls[1]?.[0])).toContain('start=10');
    const [job] = source.jobs;
    expect(job?.title).toBe('2027 Quantitative Researcher Intern 0');
    // Epoch seconds, not milliseconds: read as milliseconds this dates to 1970
    // and the row reaches the digest as the oldest thing in it.
    expect(job?.postedAt?.slice(0, 10)).toBe('2026-08-10');
    // The posting, not the API endpoint the rows arrived through.
    expect(job?.directApplyUrl).toBe('https://mlp.eightfold.ai/careers/job/700000');
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
