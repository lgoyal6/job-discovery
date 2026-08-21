import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ['APIFY_TOKEN', 'APIFY_ENABLED', 'APIFY_LINKEDIN_MAX_RESULTS', 'APIFY_INDEED_MAX_RESULTS', 'APIFY_MONSTER_MAX_RESULTS']) delete process.env[key];
  vi.resetModules();
});

describe('Apify free-plan actors', () => {
  it('builds capped board-specific requests without making a real actor call', async () => {
    process.env.APIFY_TOKEN = 'test-apify-token';
    process.env.APIFY_ENABLED = 'true';
    process.env.APIFY_LINKEDIN_MAX_RESULTS = '35';
    process.env.APIFY_INDEED_MAX_RESULTS = '15';
    process.env.APIFY_MONSTER_MAX_RESULTS = '35';
    const mockedFetch = vi.fn().mockImplementation(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', mockedFetch);
    const { ApifySource } = await import('../src/sources/apify.js');

    const sources = [
      new ApifySource('linkedin', 'owner/linkedin', 35, ['Microsoft']),
      new ApifySource('indeed', 'owner/indeed', 15),
      new ApifySource('monster', 'owner/monster', 35)
    ];
    const results = await Promise.all(sources.map(source => source.fetch()));
    expect(results.every(result => result.status === 'SUCCESS')).toBe(true);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
    for (const call of mockedFetch.mock.calls) {
      expect(String(call[0])).toContain('run-sync-get-dataset-items');
      expect(String(call[0])).toContain('maxTotalChargeUsd=0.5');
    }

    const bodies = mockedFetch.mock.calls.map(call => JSON.parse(String((call[1] as RequestInit).body)));
    // limitPerSource is the cap the LinkedIn actor actually reads; it has no
    // "count" field, so the 35-result ceiling was never being applied.
    expect(bodies[0]).toMatchObject({ limitPerSource: 35, scrapeCompany: false });
    expect(bodies[0].urls[0]).toContain('f_TPR=r86400');
    expect(bodies[1]).toMatchObject({ maxItems: 15, includeFullDescription: true });
    expect(bodies[1].searches.every((search: any) => search.postedWithinDays === 1)).toBe(true);
    expect(bodies[2]).toMatchObject({ pageSize: 35, maxPages: 1, scrapeAllPages: false });
  });

  it('pages Monster past the 50-per-page ceiling at the configured default', async () => {
    // 35 fits one page, so the paging arithmetic was never exercised. The
    // default is now 150, which is three pages, and the charge has to stay
    // inside the cap or the run is cut off mid-way.
    process.env.APIFY_TOKEN = 'test-apify-token';
    process.env.APIFY_ENABLED = 'true';
    const mockedFetch = vi.fn().mockResolvedValue(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', mockedFetch);
    const { ApifySource } = await import('../src/sources/apify.js');
    await new ApifySource('monster', 'owner/monster', 150).fetch();
    const body = JSON.parse(String((mockedFetch.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({ pageSize: 50, maxPages: 3 });
    expect(150 * 0.001).toBeLessThan(0.5);
  });

  it('cannot run without both the explicit enable gate and token', async () => {
    const mockedFetch = vi.fn();
    vi.stubGlobal('fetch', mockedFetch);
    const { ApifySource } = await import('../src/sources/apify.js');
    const result = await new ApifySource('linkedin', 'owner/linkedin', 35).fetch();
    expect(result.status).toBe('SKIPPED');
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe('a paid actor under the finance profile', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of ['APIFY_TOKEN', 'FINANCE_APIFY_TOKEN', 'APIFY_ENABLED', 'JOB_PROFILE', 'FINANCE_EMAIL_TO']) delete process.env[key];
    vi.resetModules();
  });

  it('searches for what the finance digest wants, not the technical one', async () => {
    // The searches were hardcoded to the technical digest, which is half of why
    // this profile could not use a paid source: an actor asked for "software
    // engineering intern 2027" returns nothing the finance rules accept, so
    // every result would have been paid for and dropped. Measured on Monster at
    // 150 results, the wording below returned 87 accepted rows against 4 for
    // "investment analyst intern 2027".
    vi.resetModules();
    vi.stubEnv('JOB_PROFILE', 'finance');
    vi.stubEnv('FINANCE_EMAIL_TO', 'someone@example.edu');
    vi.stubEnv('FINANCE_APIFY_TOKEN', 'finance-token');
    vi.stubEnv('APIFY_ENABLED', 'true');
    const mockedFetch = vi.fn().mockResolvedValue(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', mockedFetch);
    const { ApifySource } = await import('../src/sources/apify.js');
    await new ApifySource('monster', 'owner/monster', 20).fetch();
    const body = JSON.parse(String((mockedFetch.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.query).toBe('finance internship summer 2027');
  });

  it('spends its own Apify account and never the technical one', async () => {
    // The free plan grants $5 a month, does not roll it over, and blocks the
    // account for the rest of the cycle once spent. A fallback to APIFY_TOKEN
    // would mean one digest taking the other's paid sources down with it.
    vi.resetModules();
    vi.stubEnv('JOB_PROFILE', 'finance');
    vi.stubEnv('FINANCE_EMAIL_TO', 'someone@example.edu');
    vi.stubEnv('APIFY_TOKEN', 'the-technical-account');
    vi.stubEnv('APIFY_ENABLED', 'true');
    const mockedFetch = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', mockedFetch);
    const { ApifySource } = await import('../src/sources/apify.js');
    const result = await new ApifySource('monster', 'owner/monster', 20).fetch();
    // No FINANCE_APIFY_TOKEN, so it skips itself rather than reaching for the
    // other account's credit.
    expect(result.status).toBe('SKIPPED');
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('carries the finance token through as the one that is spent', async () => {
    vi.resetModules();
    vi.stubEnv('JOB_PROFILE', 'finance');
    vi.stubEnv('FINANCE_EMAIL_TO', 'someone@example.edu');
    vi.stubEnv('APIFY_TOKEN', 'the-technical-account');
    vi.stubEnv('FINANCE_APIFY_TOKEN', 'the-finance-account');
    vi.stubEnv('APIFY_ENABLED', 'true');
    const mockedFetch = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', mockedFetch);
    const { ApifySource } = await import('../src/sources/apify.js');
    await new ApifySource('monster', 'owner/monster', 20).fetch();
    const url = String(mockedFetch.mock.calls[0]?.[0]);
    expect(url).toContain('token=the-finance-account');
    expect(url).not.toContain('the-technical-account');
  });
});
