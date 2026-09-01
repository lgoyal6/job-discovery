import { describe, expect, it } from 'vitest';
import { resolveEmployers, stripLegal } from '../src/employer-resolution.js';
import { classifyRawJob } from '../src/pipeline.js';
import { loadCompanyAliases, loadSponsorshipPatterns, loadVerifiedNonSponsors } from '../src/config.js';
import { buildAliasMap } from '../src/normalization.js';

const ENTITIES = ['advanced micro devices', 'palantir technologies', 'raytheon technologies',
  'booz allen hamilton', 'walt disney', 'hartford', 'stripe', 'pimco', 'liveramp'];

describe('resolving a posting name onto a USCIS legal entity', () => {
  it('reaches a longer entity name by whole tokens, not by substring', () => {
    const r = resolveEmployers(['palantir', 'booz allen'], ENTITIES);
    expect(r.matched.get('palantir')).toBe('palantir technologies');
    expect(r.matched.get('booz allen')).toBe('booz allen hamilton');
  });

  it('refuses the substring matches that would be wrong', () => {
    // "imc" inside "pimco" and "ramp" inside "liveramp" are how a naive
    // contains() check invents sponsorship for the wrong company.
    const r = resolveEmployers(['imc', 'ramp'], ENTITIES);
    expect(r.matched.has('imc')).toBe(false);
    expect(r.matched.has('ramp')).toBe(false);
    expect(r.unresolved).toEqual(['imc', 'ramp']);
  });

  it('drops a leading article, which a posting writes and a filing does not', () => {
    expect(stripLegal('the walt disney company')).toBe('walt disney');
    const r = resolveEmployers(['the walt disney company', 'the hartford'], ENTITIES);
    expect(r.matched.get('the walt disney company')).toBe('walt disney');
    expect(r.matched.get('the hartford')).toBe('hartford');
  });

  it('lets a hand-checked alias outrank every pass', () => {
    // No token rule reaches "advanced micro devices" from "amd".
    const r = resolveEmployers(['amd'], ENTITIES, { amd: 'advanced micro devices' });
    expect(r.matched.get('amd')).toBe('advanced micro devices');
  });

  it('treats a null alias as verified absence rather than a match', () => {
    const r = resolveEmployers(['blue origin'], ENTITIES, { 'blue origin': null });
    expect(r.matched.has('blue origin')).toBe(false);
    expect(r.unresolved).toContain('blue origin');
  });
});

describe('the sponsorship note fires only on a checked absence', () => {
  const raw = (company: string) => ({
    sourceName: 'test', sourceJobId: company, company, title: 'Software Engineering Intern',
    location: 'Seattle, WA', postedAt: '2026-09-01T00:00:00.000Z',
    sourceUrl: 'https://example.test/1', directApplyUrl: 'https://example.test/1',
    scrapedAt: '2026-09-01T00:00:00.000Z', description: 'Currently enrolled students.'
  });
  const evidenceFor = async (company: string) => {
    const context = {
      aliases: buildAliasMap(await loadCompanyAliases()),
      patterns: await loadSponsorshipPatterns(),
      priorities: new Map<string, number>(),
      verifiedNonSponsors: await loadVerifiedNonSponsors()
    };
    return (await classifyRawJob(raw(company), context)).sponsorshipEvidence;
  };

  it('notes a checked non-sponsor', async () => {
    expect(await evidenceFor('Blue Origin')).toContain('no H-1B approvals in the USCIS export');
  });

  it('says nothing about an employer we have not checked', async () => {
    // Silence beats a guess: an unchecked name is a lookup we have not done,
    // and claiming it does not sponsor is how AMD would have been libelled.
    expect(await evidenceFor('Some Unchecked Startup')).not.toContain('no H-1B approvals');
  });
});
