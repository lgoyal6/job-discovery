import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichSponsorship, extractText, workdayJsonUrl } from '../src/enrichment.js';
import { loadSponsorshipPatterns } from '../src/config.js';
import type { DigestJob } from '../src/types.js';

const job = (over: Partial<DigestJob> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Software Engineer Intern',
  directApplyUrl: 'https://careers.example.com/jobs/1',
  canonicalUrl: 'https://careers.example.com/jobs/1',
  ...over
}) as DigestJob;

const page = (body: string) => new Response(`<html><body>${body}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
const padding = 'We are hiring engineers to build delightful products for our customers. '.repeat(12);

afterEach(() => vi.unstubAllGlobals());

describe('Workday postings', () => {
  it('maps a Workday job page to the CXS endpoint that actually carries text', () => {
    expect(workdayJsonUrl('https://globalhr.wd5.myworkdayjobs.com/fr-CA/Private_Posting_No_TMP/job/US-AL-HUNTSVILLE/Summer-2027--Software-Intern_01865160?utm_source=GHList'))
      .toBe('https://globalhr.wd5.myworkdayjobs.com/wday/cxs/globalhr/Private_Posting_No_TMP/job/US-AL-HUNTSVILLE/Summer-2027--Software-Intern_01865160');
    expect(workdayJsonUrl('https://osv-cci.wd1.myworkdayjobs.com/en-US/CCICareers/job/Stamford-CT/Full-Stack-Software-Engineer-Internship--Summer-2027-_R1350'))
      .toBe('https://osv-cci.wd1.myworkdayjobs.com/wday/cxs/osv-cci/CCICareers/job/Stamford-CT/Full-Stack-Software-Engineer-Internship--Summer-2027-_R1350');
  });

  it('leaves every other board, and a Workday URL with no posting, alone', () => {
    expect(workdayJsonUrl('https://boards.greenhouse.io/imc/jobs/1')).toBeUndefined();
    expect(workdayJsonUrl('https://jobs.lever.co/belvederetrading/abc')).toBeUndefined();
    expect(workdayJsonUrl('https://globalhr.wd5.myworkdayjobs.com/en-US/site')).toBeUndefined();
    expect(workdayJsonUrl('not a url')).toBeUndefined();
  });

  it('classifies a defence posting from the CXS description the HTML never carries', async () => {
    // RTX's page renders client-side and extracts to zero characters, so every
    // one of its roles reached the digest as "Sponsorship unclear".
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      jobPostingInfo: { jobDescription: `<p>${padding}</p><p>Citizen, U.S. Person, or Immigration Status Requirements: U.S. citizenship is required, as only U.S. citizens are authorized to access information under this program.</p>` }
    }), { status: 200 })));
    const [verdict] = await enrichSponsorship([job({ directApplyUrl: 'https://globalhr.wd5.myworkdayjobs.com/en-US/Careers/job/US-AL/Software-Intern_01865160' })], await loadSponsorshipPatterns());
    expect(verdict?.httpOk).toBe(true);
    expect(verdict?.status).toBe('UNSUPPORTED');
    expect(String((vi.mocked(fetch).mock.calls[0]?.[0]))).toContain('/wday/cxs/globalhr/Careers/job/');
  });
});

describe('posting text extraction', () => {
  it('drops scripts and styles rather than classifying their contents', () => {
    const text = extractText('<style>.a{content:"U.S. citizens only"}</style><script>var x="citizen"</script><p>Hello  world</p>');
    expect(text).toBe('Hello world');
  });

  it('decodes entities so wording is matchable', () => {
    expect(extractText('<p>U.S.&nbsp;citizens &amp; permanent residents</p>')).toBe('U.S. citizens & permanent residents');
  });
});

describe('sponsorship enrichment', () => {
  it('recovers a citizenship requirement that the listing never showed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page(`${padding} Applicants must be a U.S. citizen to be eligible for this role.`)));
    const [verdict] = await enrichSponsorship([job()], await loadSponsorshipPatterns());
    expect(verdict?.status).toBe('UNSUPPORTED');
    expect(verdict?.httpOk).toBe(true);
  });

  it('records a confirmed yes so the digest can distinguish it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page(`${padding} Visa sponsorship is available for this internship.`)));
    const [verdict] = await enrichSponsorship([job()], await loadSponsorshipPatterns());
    expect(verdict?.status).toBe('SUPPORTED');
  });

  // A client-rendered board returns 200 with no job text. That is "asked and
  // learned nothing", and must not read as a verdict either way.
  it('does not invent a verdict from a client-rendered shell', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page('<div id="root"></div>')));
    const [verdict] = await enrichSponsorship([job()], await loadSponsorshipPatterns());
    expect(verdict?.status).toBe('UNKNOWN');
    expect(verdict?.httpOk).toBe(true);
  });

  // Enrichment improves a digest; it must never be the reason one fails to send.
  it('survives network failures and non-200s without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    const verdicts = await enrichSponsorship([job(), job({ id: '22222222-2222-2222-2222-222222222222' })], await loadSponsorshipPatterns());
    expect(verdicts).toHaveLength(2);
    expect(verdicts.every(v => v.status === 'UNKNOWN' && !v.httpOk)).toBe(true);
  });

  it('skips rows with no fetchable URL instead of requesting them', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const [verdict] = await enrichSponsorship([job({ directApplyUrl: '', canonicalUrl: '' })], await loadSponsorshipPatterns());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(verdict?.status).toBe('UNKNOWN');
  });
});
