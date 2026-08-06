import { describe, expect, it } from 'vitest';
import { classifyCategory, classifyCycle, classifyGraduation, classifySponsorship } from '../src/classification.js';
import { loadCompanyAliases, loadSponsorshipPatterns } from '../src/config.js';
import { buildAliasMap, canonicalizeUrl, canonicalKey, normalizeCompany } from '../src/normalization.js';

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
