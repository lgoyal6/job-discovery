import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyEarlyCareer, classifyUaeHiring, isInUae } from '../src/classification.js';
import type { RawJob } from '../src/types.js';

// The finance reader is applying for new-grad roles in Dubai first and the US
// second. Titles below are the ones LinkedIn's guest search returned for the
// UAE on 2026-10-09.

describe('reading a UAE location', () => {
  it('reads the ways postings write the UAE', () => {
    for (const place of ['Dubai, Dubai, United Arab Emirates', 'Abu Dhabi, Abu Dhabi Emirate, United Arab Emirates', 'United Arab Emirates', 'Dubai, AE', 'DIFC', 'Abu Dhabi']) {
      expect(isInUae(place), place).toBe(true);
    }
  });

  it('leaves the US and the rest of the world alone', () => {
    for (const place of ['New York, NY', 'London', 'Riyadh', 'Doha', 'Remote', 'Unspecified']) {
      expect(isInUae(place), place).toBe(false);
    }
  });

  it('falls back to the posting URL only when the location names nothing', () => {
    expect(isInUae('Unspecified', 'Analyst https://jobs.example.test/dubai-analyst')).toBe(true);
    expect(isInUae('New York, NY', 'Analyst https://jobs.example.test/dubai-analyst')).toBe(false);
  });
});

describe('who a UAE role is open to', () => {
  it('reads an Emiratisation programme from its title', () => {
    for (const title of [
      'Graduate Development Program - Advisory, Audit and Tax (UAE Nationals)',
      'Graduate Trainee - Emiratization',
      'Graduate Trainee – Finance - Emirati Talent',
      'Emerging Talent Program - UAE National',
      'UAE National | Senior Analyst - Investments'
    ]) {
      expect(classifyUaeHiring(title).status, title).toBe('UNSUPPORTED');
    }
  });

  it('reads the explicit restriction from a description, not a passing mention', () => {
    expect(classifyUaeHiring('Finance Analyst', 'This role is open to UAE nationals only.').status).toBe('UNSUPPORTED');
    expect(classifyUaeHiring('Finance Analyst', 'We proudly support Emiratisation across the group.').status).toBe('SUPPORTED');
  });

  it('keeps a programme that only prefers UAE nationals', () => {
    const title = 'Global Markets Launch Graduate Rotational Program 2027 - Associate Analyst, Account Management- Dubai, UAE (UAE Nationals Preferred)';
    expect(classifyUaeHiring(title).status).toBe('UNKNOWN');
  });

  it('treats everything else as sponsored, because UAE employers sponsor the visa', () => {
    expect(classifyUaeHiring('IB - Corporate Finance MENA Coverage - Analyst')).toMatchObject({ status: 'SUPPORTED' });
  });
});

describe('early career in the UAE', () => {
  it('accepts a plain analyst or junior title in the UAE only', () => {
    expect(classifyEarlyCareer('IB - Corporate Finance MENA Coverage - Analyst', '', { uae: true }).eligible).toBe(true);
    expect(classifyEarlyCareer('Junior Market Analyst', '', { uae: true }).eligible).toBe(true);
    expect(classifyEarlyCareer('IB - Corporate Finance MENA Coverage - Analyst').eligible).toBe(false);
  });

  it('still drops a UAE analyst role that asks for years of experience', () => {
    expect(classifyEarlyCareer('Investment Analyst', 'Requires 3+ years of investment banking experience.', { uae: true }).eligible).toBe(false);
  });

  it('reads the Gulf wording for graduate hiring everywhere', () => {
    for (const title of ['Early Careers Program - Finance', 'Fresh Graduate Finance Analyst', 'Graduate Development Program - Finance']) {
      expect(classifyEarlyCareer(title).eligible, title).toBe(true);
    }
  });
});

describe('the pipeline under each profile', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  const dubaiRole: RawJob = {
    sourceName: 'linkedin:uae-investment-banking', sourceJobId: '1', company: 'Deutsche Bank',
    title: 'IB - Corporate Finance MENA Coverage - Analyst', location: 'Dubai, Dubai, United Arab Emirates',
    postedAt: '2026-10-08T00:00:00.000Z', sourceUrl: 'https://www.linkedin.com/jobs/view/1',
    directApplyUrl: 'https://www.linkedin.com/jobs/view/1', scrapedAt: '2026-10-09T00:00:00.000Z'
  };

  async function classifyUnder(profile: string, raw: RawJob) {
    vi.resetModules();
    vi.stubEnv('JOB_PROFILE', profile);
    vi.stubEnv('FINANCE_EMAIL_TO', 'someone@example.edu');
    const { classifyRawJob } = await import('../src/pipeline.js');
    const { loadCompanyAliases, loadSponsorshipPatterns } = await import('../src/config.js');
    const { buildAliasMap } = await import('../src/normalization.js');
    return classifyRawJob(raw, { aliases: buildAliasMap(await loadCompanyAliases()), patterns: await loadSponsorshipPatterns(), priorities: new Map() });
  }

  it('keeps a Dubai role for the finance digest and reads its visa the UAE way', async () => {
    const job = await classifyUnder('finance', dubaiRole);
    expect(job.rejectionReason).toBeUndefined();
    expect(job.sponsorshipStatus).toBe('SUPPORTED');
  });

  it('still rejects the rest of the world for the finance digest', async () => {
    const job = await classifyUnder('finance', { ...dubaiRole, location: 'Riyadh, Saudi Arabia' });
    expect(job.rejectionReason).toBe('outside_us');
  });

  it('leaves the technical digest US-only', async () => {
    const job = await classifyUnder('', { ...dubaiRole, title: 'Software Engineer Intern 2027' });
    expect(job.rejectionReason).toBe('outside_us');
  });
});
