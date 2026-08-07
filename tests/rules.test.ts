import { describe, expect, it } from 'vitest';
import { diversifiedTop, localDedupe } from '../src/pipeline.js';
import { classifyCategory, classifyCycle, classifyGraduation, classifySponsorship } from '../src/classification.js';
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
