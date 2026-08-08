import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichSponsorship, extractText } from '../src/enrichment.js';
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
