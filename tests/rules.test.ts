import { describe, expect, it } from 'vitest';
import { diversifiedTop, localDedupe } from '../src/pipeline.js';
import { boardFromUrl, slugCandidates } from '../src/discovery.js';
import { hashPageText } from '../src/sources/pagewatch.js';
import { classifyCategory, classifyCycle, classifyGraduation, classifyLocation, classifySponsorship } from '../src/classification.js';
import { loadCompanyAliases, loadSponsorshipPatterns } from '../src/config.js';
import { buildAliasMap, canonicalizeUrl, canonicalKey, normalizeCompany } from '../src/normalization.js';

const noPatterns = { supported: [], unsupported: [], ambiguous: [] };
const job = (over: Record<string, unknown>) => ({
  score: 90, company: 'X', normalizedCompany: 'x', normalizedTitle: 'software engineer intern',
  normalizedLocation: 'nyc', cycle: 'Summer 2027', canonicalKey: Math.random().toString(36),
  canonicalUrl: '', ...over
}) as never;

describe('sponsorship markers from community lists', () => {
  it('treats the no-sponsorship marker as disqualifying, over an empty pattern file', () => {
    const result = classifySponsorship('Backend Software Engineer Intern, Search \u{1F6C2}', noPatterns);
    expect(result.status).toBe('UNSUPPORTED');
  });

  it('treats the US-citizenship marker as disqualifying', () => {
    const result = classifySponsorship('Software Engineer Intern \u{1F1FA}\u{1F1F8}', noPatterns);
    expect(result.status).toBe('UNSUPPORTED');
  });

  it('still abstains when no marker and no pattern match', () => {
    expect(classifySponsorship('Software Engineer Intern', noPatterns).status).toBe('UNKNOWN');
  });
});

describe('category is judged on the title, not the description', () => {
  // Every description at a software company mentions software, security and
  // systems; matching on it filed a compliance opening as SWE.
  const techDescription = 'You will partner with software engineering on security controls across our systems and cloud platform.';

  it('does not call a governance/risk/compliance role SWE', () => {
    const result = classifyCategory('Governance, Risk, and Compliance Intern (Fall 2026)', techDescription);
    expect(result.eligible).toBe(false);
    expect(result.category).not.toBe('SWE');
  });

  it('still keeps a genuine engineering role whose title names the track', () => {
    expect(classifyCategory('Privacy and Civil Liberties Software Engineer Intern', '').category).toBe('SWE');
  });

  it('reads the description only when the title carries no track', () => {
    expect(classifyCategory('Engineering Intern', techDescription).category).toBe('SWE');
  });

  it('recognises quant titles that never say developer', () => {
    expect(classifyCategory('Quantitative Risk Intern', '').category).toBe('Quant');
    expect(classifyCategory('Quantitative Trader Intern', '').category).toBe('Quant');
  });
});

describe('sponsorship phrasings that never use the word sponsorship', () => {
  const check = async (text: string) => {
    const patterns = await loadSponsorshipPatterns();
    return classifySponsorship(text, patterns).status;
  };

  it('catches citizenship and residency requirements', async () => {
    expect(await check('Applicants must be a U.S. citizen.')).toBe('UNSUPPORTED');
    expect(await check('This role requires U.S. citizenship.')).toBe('UNSUPPORTED');
    expect(await check('Open to U.S. citizens or lawful permanent residents.')).toBe('UNSUPPORTED');
    expect(await check('Must be a U.S. person as defined by ITAR.')).toBe('UNSUPPORTED');
  });

  it('catches negative sponsorship phrasings', async () => {
    expect(await check('We are unable to sponsor visas for this position.')).toBe('UNSUPPORTED');
    expect(await check('Our company does not sponsor employment visas.')).toBe('UNSUPPORTED');
    expect(await check('Candidates must be authorized to work without sponsorship now or in the future.')).toBe('UNSUPPORTED');
    expect(await check('No visa sponsorship is offered for interns.')).toBe('UNSUPPORTED');
  });

  it('does not fire on equal-opportunity boilerplate', async () => {
    expect(await check('We consider all applicants regardless of citizenship status or national origin.')).not.toBe('UNSUPPORTED');
    expect(await check('Visa sponsorship is available for this role.')).toBe('SUPPORTED');
  });
});

describe('digest shaping', () => {
  it('merges the same requisition described differently by different lists', () => {
    const { unique, count } = localDedupe([
      job({ normalizedTitle: 'software engineer intern c++ or python', score: 95 }),
      job({ normalizedTitle: 'software engineering internship c++ or python summer 2027', score: 90 }),
      job({ normalizedTitle: 'software engineering intern summer 2027 c++ python', score: 85 })
    ]);
    expect(unique).toHaveLength(1);
    expect(count).toBe(2);
    expect(unique[0]?.score).toBe(95);
  });

  it('keeps genuinely different teams at the same company apart', () => {
    const { unique } = localDedupe([
      job({ normalizedTitle: 'software engineer intern backend' }),
      job({ normalizedTitle: 'software engineer intern frontend' })
    ]);
    expect(unique).toHaveLength(2);
  });

  it('stops one high-volume employer from swallowing the cap', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      job({ company: 'TikTok', normalizedCompany: 'tiktok', normalizedTitle: `role ${i}`, score: 95 }));
    const others = ['Stripe', 'Ramp', 'Figma', 'Notion'].map(name =>
      job({ company: name, normalizedCompany: name.toLowerCase(), score: 95 }));
    const top = diversifiedTop([...many, ...others], 8);
    expect(top).toHaveLength(8);
    expect(top.filter(j => j.company === 'TikTok').length).toBeLessThanOrEqual(4);
    expect(new Set(top.map(j => j.company)).size).toBe(5);
  });
});
describe('normalization', () => {
  it('canonicalizes URLs by stripping tracking and preserving semantic parameters', () => {
    expect(canonicalizeUrl('https://WWW.Example.com/jobs/123/?utm_source=x&department=eng#top')).toBe('https://example.com/jobs/123?department=eng');
  });

  it('normalizes company aliases and parent/subsidiary names', async () => {
    const aliases = buildAliasMap(await loadCompanyAliases());
    expect(normalizeCompany('GitHub', aliases).display).toBe('Microsoft');
    expect(normalizeCompany('Respawn Entertainment', aliases).display).toBe('Electronic Arts');
  });

  it('prioritizes source job IDs in canonical keys', () => {
    const base = { sourceName: 'greenhouse:acme', canonicalUrl: 'https://a.test/jobs/1', normalizedCompany: 'acme', normalizedTitle: 'intern', normalizedLocation: 'remote', cycle: 'Summer 2027' };
    expect(canonicalKey({ ...base, sourceJobId: '1' })).not.toBe(canonicalKey({ ...base, sourceJobId: '2' }));
  });
});

describe('deterministic role rules', () => {
  it('classifies technical categories and excludes nontechnical or hardware-only roles', () => {
    expect(classifyCategory('Computer Vision Research Engineer Intern').category).toBe('ML/AI');
    expect(classifyCategory('Forward Deployed Engineer Intern').category).toBe('GTM Eng');
    expect(classifyCategory('Firmware Engineering Co-op').category).toBe('SWE');
    expect(classifyCategory('Marketing Intern').eligible).toBe(false);
    expect(classifyCategory('Analog Hardware Intern').eligible).toBe(false);
    expect(classifyCategory('Embedded Hardware Intern', 'C++ firmware').eligible).toBe(true);
    expect(classifyCategory('Summer Internship Program, all tracks').eligible).toBe(false);
    expect(classifyCategory('Engineering Intern').eligible).toBe(false);
    expect(classifyCategory('Information Technology Intern').eligible).toBe(false);
  });

  it('classifies target cycles in priority-compatible form', () => {
    expect(classifyCycle('Software Intern — Summer 2027')).toBe('Summer 2027');
    expect(classifyCycle('Data Co-op', '', 'Fall 2026')).toBe('Fall 2026');
    expect(classifyCycle('ML Intern Winter 2027')).toBe('Winter 2027');
    expect(classifyCycle('Intern', 'Spring 2027 program')).toBe('Spring 2027');
    expect(classifyCycle('Software Intern Winter 2027', '', 'Summer 2027')).toBe('Winter 2027');
  });

  it('reads a season that is separated from its year by a term word', () => {
    // Belvedere's "Winter Quarter 2027" matched no season, so the role took the
    // Summer hint of the list that carried it and shipped as a Summer role.
    expect(classifyCycle('Quantitative Trading Intern - Winter Quarter 2027', '', 'Summer 2027')).toBe('Winter 2027');
    expect(classifyCycle('Software Engineer Intern, Fall Term 2026')).toBe('Fall 2026');
    expect(classifyCycle('SWE Intern - Spring Semester 2027')).toBe('Spring 2027');
    expect(classifyCycle('Summer Internship 2027')).toBe('Summer 2027');
  });

  it('lets the title outrank a description that advertises the whole program', () => {
    expect(classifyCycle('Quantitative Trading Intern - Winter Quarter 2027', 'We run Summer 2027 and off-cycle internships.')).toBe('Winter 2027');
  });

  it('keeps a role outside the United States out of the digest', () => {
    // IMC's Hong Kong postings reached the digest because location only ever
    // moved the score.
    expect(classifyLocation('Hong Kong, Hong Kong').eligible).toBe(false);
    expect(classifyLocation('Amsterdam, Netherlands').eligible).toBe(false);
    expect(classifyLocation('London, United Kingdom').eligible).toBe(false);
    expect(classifyLocation('Chicago, United States').eligible).toBe(true);
    expect(classifyLocation('Chicago, IL').eligible).toBe(true);
    expect(classifyLocation('Chicago, Illinois').eligible).toBe(true);
    expect(classifyLocation('San Diego, CA').eligible).toBe(true);
    expect(classifyLocation('Remote').eligible).toBe(true);
    // Ontario is in California and London is in Kentucky, so a US state beats a
    // country name; an unqualified city is kept rather than guessed at.
    expect(classifyLocation('Ontario, CA').eligible).toBe(true);
    expect(classifyLocation('London, KY').eligible).toBe(true);
    expect(classifyLocation('Albuquerque, New Mexico').eligible).toBe(true);
    expect(classifyLocation('Unspecified').eligible).toBe(true);
  });

  it('rejects incompatible 2027 new-grad/graduation windows and accepts explicit 2028', () => {
    expect(classifyGraduation('Software Engineer New Grad 2027', 'Must graduate in 2027').eligible).toBe(false);
    expect(classifyGraduation('Software Engineer New Grad', 'Graduating between December 2027 and June 2028').eligible).toBe(true);
    expect(classifyGraduation('Software Engineering Intern', 'Currently enrolled').eligible).toBe(true);
  });

  it('classifies sponsorship positive, negative, and ambiguous language', async () => {
    const patterns = await loadSponsorshipPatterns();
    expect(classifySponsorship('International students are eligible and visa sponsorship is available.', patterns).status).toBe('SUPPORTED');
    expect(classifySponsorship('Must not now or in the future require sponsorship.', patterns).status).toBe('UNSUPPORTED');
    expect(classifySponsorship('Must be authorized to work in the United States.', patterns).status).toBe('UNKNOWN');
    expect(classifySponsorship('No policy stated.', patterns).status).toBe('UNKNOWN');
  });
});

describe('board discovery', () => {
  it('derives the slug spellings ATS boards actually use', () => {
    expect(slugCandidates('Jane Street')).toContain('janestreet');
    expect(slugCandidates('Jane Street')).toContain('jane-street');
    // Legal suffixes are usually absent from the board slug.
    expect(slugCandidates('Rocket Lab Inc')).toContain('rocketlab');
    expect(slugCandidates('Point72')).toContain('point72');
  });

  it('drops slugs too short to be real boards', () => {
    expect(slugCandidates('X')).toHaveLength(0);
  });
});

describe('board harvesting from observed apply URLs', () => {
  it('extracts slugs a company name could never produce', () => {
    expect(boardFromUrl('https://boards.greenhouse.io/embedxyz/jobs/123')).toEqual({ ats: 'greenhouse', board: 'embedxyz' });
    expect(boardFromUrl('https://job-boards.greenhouse.io/towerresearchcapital/jobs/9')).toEqual({ ats: 'greenhouse', board: 'towerresearchcapital' });
    expect(boardFromUrl('https://jobs.lever.co/belvederetrading/abc')).toEqual({ ats: 'lever', board: 'belvederetrading' });
    expect(boardFromUrl('https://jobs.ashbyhq.com/rivianvw/xyz')).toEqual({ ats: 'ashby', board: 'rivianvw' });
  });

  it('ignores non-board URLs and greenhouse embed paths', () => {
    expect(boardFromUrl('https://careers.google.com/jobs/results/123')).toBeNull();
    expect(boardFromUrl('https://boards.greenhouse.io/embed/job_board?for=acme')).toBeNull();
  });
});

describe('program page watching', () => {
  // A first sighting must establish a baseline, never fire. Otherwise every
  // newly added page emails on the run that introduces it.
  it('hashes identical text identically and different text differently', () => {
    expect(hashPageText('applications open in July')).toBe(hashPageText('applications open in July'));
    expect(hashPageText('applications open in July')).not.toBe(hashPageText('applications are now open'));
  });
});
