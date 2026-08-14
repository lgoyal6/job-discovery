import { describe, expect, it, vi, afterEach } from 'vitest';
import { classifyCategory, classifyCycle } from '../src/classification.js';
import { classifyRawJob, collapseByRequisition, diversifiedTop } from '../src/pipeline.js';
import { materialFingerprint, buildAliasMap } from '../src/normalization.js';
import { normalizeGreenhouse, normalizeLever, normalizeAshby, normalizeSmartRecruiters } from '../src/sources/ats.js';
import { loadCompanyAliases, loadSponsorshipPatterns } from '../src/config.js';
import { fetchWithPolicy } from '../src/http.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// These guard classes of failure this pipeline has actually suffered, not the
// shape of the current code. Each one is written to die under a specific
// plausible edit, which is noted above it, so a future change that reintroduces
// the failure fails here rather than in a Tuesday morning digest.

// ---------------------------------------------------------------------------
// Four separate outages came from \b landing on a word character. \bsecurity\b
// missed "Cybersecurity", \bintern\b missed "Internships", \bstudent\b missed
// "Students", and the season rule could not cross the dash in "Internship -
// 2027". Every one was silent: the role was simply absent.
//
// Dies if any role-word pattern is narrowed back to a singular-only or
// space-only form.
// ---------------------------------------------------------------------------
describe('a role word must survive its plural and compound forms', () => {
  const eligible = (title: string) => classifyCategory(title, '').eligible;

  it('reads security however the employer compounds it', () => {
    for (const title of ['Security Engineer Intern', 'Cybersecurity Intern', 'Cyber Security Intern', 'Information Security Intern']) {
      expect(eligible(title), title).toBe(true);
    }
  });

  it('reads intern, interns, internship and internships alike', async () => {
    const context = {
      aliases: buildAliasMap(await loadCompanyAliases()),
      patterns: await loadSponsorshipPatterns(),
      priorities: new Map<string, number>()
    };
    const gate = async (title: string) => (await classifyRawJob({
      sourceName: 'test', sourceJobId: title, company: 'Acme', title, location: 'Austin, TX',
      postedAt: '2026-08-13T00:00:00.000Z', sourceUrl: 'https://a.test/1', scrapedAt: '2026-08-13T00:00:00.000Z'
    }, context)).rejectionReason;

    for (const word of ['Intern', 'Interns', 'Internship', 'Internships']) {
      expect(await gate(`Software Engineer ${word} 2027`), word).not.toBe('not_student_role');
    }
    for (const word of ['Co-op', 'Co-ops', 'Coop', 'Student', 'Students']) {
      expect(await gate(`Data Engineer ${word} 2027`), word).not.toBe('not_student_role');
    }
  });

  it('gives a cycle to every spelling of an internship year', () => {
    for (const title of ['Quant Analyst Internships 2027', 'Software Engineer Internship 2027', 'Research Interns 2027']) {
      expect(classifyCycle(title), title).not.toBeNull();
    }
  });

  // The boundary is load-bearing. Widening the plurals must not start matching
  // a word that merely opens with the same letters. Asserted through the
  // student gate, where the intern word is the only thing being judged, so an
  // unrelated keyword in the title cannot mask the result.
  it('still refuses a word that only begins with intern', async () => {
    const context = {
      aliases: buildAliasMap(await loadCompanyAliases()),
      patterns: await loadSponsorshipPatterns(),
      priorities: new Map<string, number>()
    };
    const gate = async (title: string) => (await classifyRawJob({
      sourceName: 'test', sourceJobId: title, company: 'Acme', title, location: 'Austin, TX',
      postedAt: '2026-08-13T00:00:00.000Z', sourceUrl: 'https://a.test/1', scrapedAt: '2026-08-13T00:00:00.000Z'
    }, context)).rejectionReason;
    for (const title of ['Internal Software Auditor 2027', 'International Systems Manager 2027', 'Interstellar Systems Lead 2027']) {
      expect(await gate(title), title).toBe('not_student_role');
    }
  });

  // Dies if TERM's separator goes back to \s*.
  it('crosses whatever punctuation separates a season from its year', () => {
    expect(classifyCycle('Software Developer Summer Internship - 2027')).toBe('Summer 2027');
    expect(classifyCycle('Summer Internship – 2027')).toBe('Summer 2027');
    expect(classifyCycle('Summer Internship — 2027')).toBe('Summer 2027');
    expect(classifyCycle('Summer Internship: 2027')).toBe('Summer 2027');
    expect(classifyCycle('Summer Internship, 2027')).toBe('Summer 2027');
    // The case the term word was added for, which must not regress.
    expect(classifyCycle('Quantitative Trading Intern - Winter Quarter 2027', '', 'Summer 2027')).toBe('Winter 2027');
  });
});

// ---------------------------------------------------------------------------
// A community list carries a cycle hint describing the list, and it was allowed
// to answer for a posting whose title named a different year. Five roles reached
// one digest labelled Summer 2027 with 2026 in their own titles, including an
// "Internship - Summer 2026" whose cycle had already finished.
//
// Dies if the hint is consulted again without checking the title's years, or if
// a contradicted hint is let back into the Later-compatible fallback.
// ---------------------------------------------------------------------------
describe('a list hint must not overrule the year in the title', () => {
  const summerList = 'Summer 2027';

  it('drops a posting whose own title names a different year', () => {
    for (const title of [
      'AI Engineer - Internship - Summer 2026 - Applications Open',
      '2026 Intern Conversion - Software Development Engineer I',
      'PhD Research Intern - Generative AI - 2026',
      '2026 Machine Learning Intern - Autonomy'
    ]) {
      expect(classifyCycle(title, '', summerList), title).toBeNull();
    }
  });

  // The hint is the only evidence for most postings, so contradiction has to be
  // the narrow case, not the default.
  it('still trusts the hint when the title does not contradict it', () => {
    expect(classifyCycle('Software Engineer Intern', '', summerList)).toBe('Summer 2027');
    expect(classifyCycle('Data Co-op', '', 'Fall 2026')).toBe('Fall 2026');
    // Spans both years, so the hint picks the half that matters.
    expect(classifyCycle('Software Engineer (Agent Platform) - Intern - 2026-2027', '', summerList)).toBe('Summer 2027');
    expect(classifyCycle('Software Engineer Intern 2027', '', summerList)).toBe('Summer 2027');
  });

  it('lets a title name its own cycle over any hint', () => {
    expect(classifyCycle('Software Intern Winter 2027', '', summerList)).toBe('Winter 2027');
    expect(classifyCycle('Quantitative Trading Intern - Winter Quarter 2027', '', summerList)).toBe('Winter 2027');
  });

  // The hint's year must not qualify the posting through the back door.
  it('keeps a contradicted hint out of the later-compatible fallback', () => {
    expect(classifyCycle('2026 Machine Learning Intern', '', 'Summer 2027')).toBeNull();
    expect(classifyCycle('Machine Learning Intern', '', 'Summer 2027')).toBe('Summer 2027');
  });
});

// ---------------------------------------------------------------------------
// z.string().optional() accepts a missing key and rejects an explicit null.
// Greenhouse sends first_published: null, the whole jobs array is parsed in one
// call, and 16 null rows destroyed 171 postings across four boards.
//
// Dies if any adapter gains a field typed .optional() instead of .nullish(),
// which is the single edit that caused the outage.
// ---------------------------------------------------------------------------
describe('an explicit null must never cost a whole board', () => {
  const now = '2026-08-13T00:00:00.000Z';

  it('keeps a Greenhouse board whose row nulls every optional field', () => {
    const jobs = normalizeGreenhouse({
      jobs: [
        { id: 1, title: 'SWE Intern', absolute_url: 'https://boards.greenhouse.io/a/jobs/1', location: { name: 'Austin, TX' }, first_published: null, updated_at: null, content: null },
        { id: 2, title: 'Data Intern', absolute_url: 'https://boards.greenhouse.io/a/jobs/2', location: { name: 'Austin, TX' }, first_published: '2026-07-01T00:00:00Z' }
      ]
    }, { type: 'greenhouse', board: 'a', company: 'Acme' }, now);
    expect(jobs).toHaveLength(2);
  });

  it('keeps a Lever board whose row nulls every optional field', () => {
    const jobs = normalizeLever([
      { id: 'l1', text: 'SWE Intern', hostedUrl: 'https://jobs.lever.co/a/1', applyUrl: null, createdAt: null, descriptionPlain: null, categories: { location: null, commitment: null } }
    ], { type: 'lever', site: 'a', company: 'Acme' }, now);
    expect(jobs).toHaveLength(1);
  });

  it('keeps an Ashby board whose row nulls every optional field', () => {
    const jobs = normalizeAshby({
      jobs: [{ id: null, title: 'SWE Intern', location: null, publishedAt: null, jobUrl: 'https://jobs.ashbyhq.com/a/1', applyUrl: null, descriptionPlain: null, employmentType: null }]
    }, { type: 'ashby', board: 'a', company: 'Acme' }, now);
    expect(jobs).toHaveLength(1);
  });

  it('keeps a SmartRecruiters board whose row nulls every optional field', () => {
    const jobs = normalizeSmartRecruiters({
      content: [{ id: 's1', name: 'SWE Intern', ref: 'https://jobs.smartrecruiters.com/a/1', releasedDate: null, location: { city: null, region: null, country: null } }]
    }, { type: 'smartrecruiters', companyId: 'a', company: 'Acme' }, now);
    expect(jobs).toHaveLength(1);
  });

  // One bad row must not take its neighbours with it. If a schema ever does
  // reject a row, this records that the blast radius is the board.
  it('is an all-or-nothing parse, so a tolerant schema is the only defence', () => {
    const withOneNull = {
      jobs: Array.from({ length: 50 }, (_, index) => ({
        id: index, title: `Intern ${index}`, absolute_url: `https://boards.greenhouse.io/a/jobs/${index}`,
        location: { name: 'Austin, TX' }, first_published: index === 7 ? null : '2026-07-01T00:00:00Z'
      }))
    };
    expect(normalizeGreenhouse(withOneNull, { type: 'greenhouse', board: 'a', company: 'Acme' }, now)).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// A changed fingerprint clears sent_at and mails the role again. The apply URL
// was in it, so Optiver's Chicago internship arrived twice two hours apart
// simply because LinkedIn and speedyapply link the same requisition differently.
//
// Dies if any volatile field is added back to the fingerprint.
// ---------------------------------------------------------------------------
describe('a re-send must mean the role changed, not that a new list found it', () => {
  const role = { title: 'Software Engineer Intern (Summer 2027 - Chicago)', location: 'Chicago, IL', cycle: 'Summer 2027' };

  it('ignores every field except title, location and cycle', () => {
    const base = materialFingerprint(role);
    const volatile: Record<string, unknown>[] = [
      { directApplyUrl: 'https://www.linkedin.com/jobs/view/4454310475' },
      { sourceUrl: 'https://speedyapply.test/x' },
      { sourceName: 'speedyapply' },
      { score: 116 },
      { postedAt: '2026-07-02T00:00:00.000Z' },
      { description: 'a description the other list happened to carry' },
      { requiredSkills: ['Python', 'AWS'] },
      { sponsorshipStatus: 'SUPPORTED' }
    ];
    for (const extra of volatile) {
      expect(materialFingerprint({ ...role, ...extra } as never), Object.keys(extra)[0]).toBe(base);
    }
  });

  it('still fires on the three changes worth an email', () => {
    const base = materialFingerprint(role);
    expect(materialFingerprint({ ...role, title: 'Quantitative Trader Intern' })).not.toBe(base);
    expect(materialFingerprint({ ...role, location: 'Austin, TX' })).not.toBe(base);
    expect(materialFingerprint({ ...role, cycle: 'Winter 2027' })).not.toBe(base);
  });

  // Punctuation is not a change. Two lists writing the same title differently
  // is the exact situation that caused the duplicate.
  it('treats the same title punctuated differently as the same role', () => {
    expect(materialFingerprint(role)).toBe(materialFingerprint({
      title: 'Software Engineer Intern - Summer 2027 - Chicago', location: 'Chicago, IL', cycle: 'Summer 2027'
    }));
  });
});

// ---------------------------------------------------------------------------
// The digest shows one row per requisition, but every posting behind that row
// must still reach the email batch. A member dropped here keeps sent_at NULL
// and the whole family arrives again on every future run, forever.
//
// Dies if the collapse ever returns fewer members than it was given.
// ---------------------------------------------------------------------------
describe('collapsing rows must never lose a posting', () => {
  const posting = (over: Record<string, unknown>) => ({
    score: 70, company: 'IBM', normalizedCompany: 'ibm', normalizedTitle: 'servicenow developer intern',
    normalizedLocation: 'x', location: 'Austin, TX', cycle: 'Later compatible',
    canonicalKey: Math.random().toString(36), canonicalUrl: '', ...over
  }) as never;

  it('conserves every posting across many shapes of input', () => {
    const shapes = [
      // one family, many cities
      ['NY', 'TX', 'IL', 'MI', 'CA'].map(place => posting({ location: place })),
      // two families at one company
      [posting({ normalizedTitle: 'servicenow developer intern' }), posting({ normalizedTitle: 'aws developer intern' })],
      // same title, different cycles
      [posting({ cycle: 'Summer 2027' }), posting({ cycle: 'Fall 2026' })],
      // same title, different companies
      [posting({ normalizedCompany: 'ibm' }), posting({ normalizedCompany: 'delta' })],
      // a title that reduces to no signature at all
      [posting({ normalizedTitle: 'intern' }), posting({ normalizedTitle: 'intern' })],
      // a single posting
      [posting({})]
    ];
    for (const [index, jobs] of shapes.entries()) {
      const groups = collapseByRequisition(jobs);
      const members = groups.flatMap(group => group.members);
      expect(members, `shape ${index}`).toHaveLength(jobs.length);
      // Every group must name a representative that is one of its own members.
      for (const group of groups) {
        expect(group.members).toContain(group.members.find(member => member.score === group.display.score));
      }
    }
  });

  // Conservation alone cannot see a wrong grouping: dropping a component from
  // the key still returns every member, just in the wrong buckets. Each of the
  // three parts is varied on its own, so narrowing the key fails here.
  it('groups on company, cycle and title together, and nothing less', () => {
    const pair = (second: Record<string, unknown>) => collapseByRequisition([
      posting({ normalizedCompany: 'ibm', cycle: 'Summer 2027', normalizedTitle: 'servicenow developer intern' }),
      posting({ normalizedCompany: 'ibm', cycle: 'Summer 2027', normalizedTitle: 'servicenow developer intern', ...second })
    ]);
    expect(pair({}), 'identical postings are one requisition').toHaveLength(1);
    expect(pair({ normalizedCompany: 'delta' }), 'company must split').toHaveLength(2);
    expect(pair({ cycle: 'Fall 2026' }), 'cycle must split').toHaveLength(2);
    expect(pair({ normalizedTitle: 'aws developer intern' }), 'title must split').toHaveLength(2);
    // Word order and punctuation are not a difference; that is the whole point.
    expect(pair({ normalizedTitle: 'developer servicenow intern' }), 'word order must not split').toHaveLength(1);
  });

  it('represents a family with its best-scoring posting', () => {
    const groups = collapseByRequisition([
      posting({ location: 'Austin, TX', score: 70 }),
      posting({ location: 'Boston, MA', score: 91 }),
      posting({ location: 'Denver, CO', score: 80 })
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.display.score).toBe(91);
  });

  // The cap counts rows. If the collapse ever moves after it, one employer's
  // cities eat the whole digest again, which is the bug it was written for.
  it('spends the cap on requisitions, not on one employer’s cities', () => {
    const ibm = Array.from({ length: 40 }, (_, index) => posting({ location: `City ${index}` }));
    const others = ['stripe', 'figma', 'ramp'].map(name =>
      posting({ company: name, normalizedCompany: name, normalizedTitle: `${name} swe intern`, score: 95 }));
    const groups = collapseByRequisition([...ibm, ...others]);
    expect(groups).toHaveLength(4);
    const rows = diversifiedTop(groups.map(group => group.display), 10);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map(row => row.normalizedCompany)).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// "apify:linkedin: HTTP 400" was undiagnosable for days. The body said the
// actor had timed out, and the Indeed body named a $1.00 minimum charge, but
// fetchWithPolicy threw the status and dropped the body.
//
// Dies if the body stops being carried, or if it stops being bounded.
// ---------------------------------------------------------------------------
describe('a failed request must say what the server said', () => {
  const failWith = async (status: number, body: string) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status })));
    return await fetchWithPolicy('https://x.test/a', { sourceName: 's', timeoutMs: 500, retries: 0 })
      .then(() => '', (error: Error) => error.message);
  };

  it('names the reason for the failures that actually happened', async () => {
    expect(await failWith(400, '{"error":{"type":"max-total-charge-usd-below-minimum","message":"Maximum cost per run is less than the allowed minimum of $1.00"}}'))
      .toContain('minimum of $1.00');
    expect(await failWith(400, '{"error":{"type":"run-failed","message":"Actor run did not succeed (status: TIMED-OUT)."}}'))
      .toContain('TIMED-OUT');
    expect(await failWith(401, '{"error":{"type":"user-or-token-not-found"}}')).toContain('user-or-token-not-found');
  });

  it('keeps the status readable at the front of the message', async () => {
    expect(await failWith(404, 'no such board')).toMatch(/^HTTP 404/);
  });

  // An HTML error page must not push the rest of the digest out of the email.
  it('bounds a hostile body', async () => {
    const message = await failWith(400, '<html>' + 'x'.repeat(100_000) + '</html>');
    expect(message.length).toBeLessThanOrEqual('HTTP 400: '.length + 300);
  });

  it('collapses the whitespace an HTML body brings with it', async () => {
    expect(await failWith(400, 'line one\n\n\tline two')).toBe('HTTP 400: line one line two');
  });
});
