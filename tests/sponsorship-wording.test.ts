import { describe, expect, it } from 'vitest';
import { classifySponsorship } from '../src/classification.js';
import { loadSponsorshipPatterns } from '../src/config.js';

// Every string below is a verbatim excerpt from a posting the finance digest
// carried on 20 Aug 2026, sampled across forty requisitions to find out why the
// sponsorship field read UNKNOWN on thirty-nine of them. One in forty stated a
// policy the rules matched; five more stated one in wording they missed; the
// rest either said nothing or used the word "sponsor" for something else
// entirely. These are the five, and the ones that must never be read as policy.
const patterns = await loadSponsorshipPatterns();
const verdict = (text: string): string => classifySponsorship(text, patterns).status;

describe('a policy the posting actually states', () => {
  it('reads the five wordings that were being missed', () => {
    const stated: Array<[string, string]> = [
      ['Baird', 'Baird is not currently hiring individuals for this position who now or in the future require sponsorship for employment visa status. Baird is committed to diversity.'],
      ['FTI Consulting', 'Applicants must be authorized to work in the United States on a full-time basis as a full-time employee; this position does not provide visa sponsorship. Ability to travel.'],
      ['Vanguard', 'Special Factors: Vanguard is not offering visa sponsorship for this position. Relocation available to those who qualify.'],
      ['CNO Financial', 'Candidates must currently possess unrestricted authorization to work in the United States. Work cannot be performed from outside of the United States.'],
      ['Royal Caribbean', 'Must have authorization to work in the U.S. on a permanent and ongoing basis. Previous experience in related areas preferred.']
    ];
    for (const [employer, text] of stated) expect(verdict(text), employer).toBe('UNSUPPORTED');
  });
});

describe('the word "sponsor" where it is not a policy', () => {
  it('does not read an application form question as an answer', () => {
    // Eight of the forty postings sampled end in this question. It is put to the
    // candidate; the employer has said nothing. Every rule is anchored on
    // declarative or imperative wording so that none of these can match.
    const questions = [
      'Will you now or in the future require sponsorship for employment visa status? * Select...',
      'Will you require immigration sponsorship to begin working for IMC? Examples of sponsorship would include (but is not limited to) F-1 OPT, H-1B, H-4 EAD, L-1, L-2, TN, O-1, J-1.',
      'Are you lawfully authorized to work in the United States? Yes No Will you need sponsorship at any point in the future to maintain lawful employment in the United States?',
      'Please select one of the following statements based on your work authorization: * Select...'
    ];
    for (const text of questions) expect(verdict(text), text.slice(0, 40)).toBe('UNKNOWN');
  });

  it('does not read a sponsored event, a benefit plan or a team name as a visa policy', () => {
    const noise = [
      'If you have attended a Flow Traders sponsored event, please list below.',
      'discretionary bonuses, other short and long-term incentive packages, and other Morgan Stanley sponsored benefit programs.',
      'a highly competitive sign-on bonus, housing stipend or covered living accommodations, company-sponsored travel, and on-site benefits.',
      'Barclays hiring Investment Banking Briefing Funds & Sponsors Coverage, Analyst in New York, NY',
      'religion, creed, national origin, age, ancestry, disability, medical condition, citizenship, marital status, pregnancy, veteran or military status, genetic information or any other characteristic protected by applicable law.'
    ];
    for (const text of noise) expect(verdict(text), text.slice(0, 40)).toBe('UNKNOWN');
  });

  it('leaves genuinely ambiguous wording alone rather than guessing', () => {
    // An F-1 student on CPT or OPT *is* authorized to work, so neither of these
    // sentences excludes this reader and neither may be reported as if it did.
    expect(verdict('Minimum cumulative GPA of 3.2 on a 4.0 scale. Authorization to work in the U.S.')).toBe('UNKNOWN');
    expect(verdict('Must be authorized to work in the US as defined by the Immigration Act of 1986.')).toBe('UNKNOWN');
  });
});

describe('reading the posting LinkedIn actually serves', () => {
  it('rewrites a job view URL to the guest fragment its own UI fetches', async () => {
    const { linkedinGuestUrl } = await import('../src/enrichment.js');
    // The id is the trailing number of the slug.
    expect(linkedinGuestUrl('https://www.linkedin.com/jobs/view/associate-private-equity-special-opportunities-group-summer-2027-start-san-francisco-at-gic-4408102238'))
      .toBe('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4408102238');
    expect(linkedinGuestUrl('https://www.linkedin.com/jobs/view/4408102238'))
      .toBe('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4408102238');
  });

  it('leaves every other host alone', async () => {
    const { linkedinGuestUrl } = await import('../src/enrichment.js');
    for (const url of ['https://boards.greenhouse.io/imc/jobs/4907399101', 'https://www.linkedin.com/company/pimco',
      'https://ms.wd5.myworkdayjobs.com/en-US/External/job/New-York/Analyst_JR1', 'not a url']) {
      expect(linkedinGuestUrl(url), url).toBeUndefined();
    }
  });
});
