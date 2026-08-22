import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyCategory, classifyFinanceCategory, classifyLocation, rolePolicies } from '../src/classification.js';

describe('finance role rules', () => {
  it('keeps the front office', () => {
    const cases: Array<[string, string]> = [
      ['Investment Banking Summer Analyst Program 2027', 'IB'],
      ['Banking Analyst Summer Internship Program 2027', 'IB'],
      ['2027 Summer Intern - Capital Markets Group Analyst', 'IB'],
      ['Private Equity Associate', 'PE/VC'],
      ['Venture Capital Investment Intern', 'PE/VC'],
      ['Private Wealth Management Internship - Summer 2027', 'AM/WM'],
      ['Asset & Wealth Management, Private Wealth Management Analyst', 'AM/WM'],
      ['Merrill Advisor Development Program - Financial Advisor', 'AM/WM'],
      ['Quantitative Trader Intern - Summer 2027', 'Quant'],
      // Quant is tested ahead of the general investment-management desk, so the
      // label on this row says what the job is.
      ['Quantitative Research Analyst - Intern (US)', 'Quant'],
      ['FP&A Internship - Summer 2027', 'Corp Fin'],
      ['Intern, Finance (Summer 2027)', 'Corp Fin']
    ];
    for (const [title, category] of cases) {
      expect(classifyFinanceCategory(title), title).toMatchObject({ category, eligible: true });
    }
  });

  it('keeps the roles this digest was actually asked for', () => {
    // The reader's own list: investment management, investment analysis, wealth
    // management, asset management, private and public investing, private and
    // public markets, equity research, and plain finance internships.
    const cases: Array<[string, string]> = [
      ['2027 Investment Management Summer Analyst', 'AM/WM'],
      // Private debt and equity, so the private-markets desk claims it ahead of
      // the general investment-management one. Both are investing rows.
      ['Investment Analyst Intern - Private Debt & Equity, Summer 2027', 'PE/VC'],
      ['Internship in Portfolio Management (Undergraduate & Master\'s)', 'AM/WM'],
      ['Public Investments - Credit Investment Intern, Summer 2027', 'AM/WM'],
      ['Early Career Intern - Fundamental Equities', 'AM/WM'],
      ['Summer 2027 Fixed Income Credit Research Intern', 'AM/WM'],
      ['Research Associate - Early Careers Program 2027', 'AM/WM'],
      ['2027 Private Equity Summer Analyst', 'PE/VC'],
      ['2027 Private Credit Strategies Summer Analyst', 'PE/VC'],
      ['Private Markets Investment Intern', 'PE/VC'],
      ['2026-2027 - Commercial & Investment Bank - Markets Equity Research - Part Time Analyst Internship', 'IB']
    ];
    for (const [title, category] of cases) {
      expect(classifyFinanceCategory(title), title).toMatchObject({ category, eligible: true });
    }
  });

  it('drops commercial banking, which was asked for by name', () => {
    for (const title of ['Summer 2027 Commercial Banking Intern Houston, TX', 'Corporate Banking Analyst Program',
      'ETP Intern - Corporate Banking Group, Commercial Credit Products', 'Retail Banking Summer Intern',
      'Business Banking Relationship Manager Intern', 'National Lending Intern (Summer, 2027)',
      'Mortgage Operations Intern', 'Treasury Management Analyst Intern']) {
      expect(classifyFinanceCategory(title), title).toMatchObject({ eligible: false });
    }
    expect(classifyFinanceCategory('Summer 2027 Commercial Banking Intern')).toMatchObject({ reason: 'commercial_banking' });
  });

  it('drops the back office, the insurance desk and the risk desk', () => {
    const cases: Array<[string, string]> = [
      ['2027 Summer Intern - Trade Support Analyst', 'back_office_operations'],
      ['2027 - Summer Analyst Internship - Corporate Functions, Operations', 'back_office_operations'],
      ['2026 Client Service Junior Analyst', 'back_office_operations'],
      ['Fund Administration Intern', 'back_office_operations'],
      ['Summer 2027 Actuarial Internship', 'insurance_risk_or_compliance'],
      ['Summer 2027 Underwriting Operations Internship', 'back_office_operations'],
      ['Summer 2027 Internship - Risk Management', 'insurance_risk_or_compliance'],
      ['Compliance Intern - Summer 2027', 'insurance_risk_or_compliance']
    ];
    for (const [title, reason] of cases) {
      expect(classifyFinanceCategory(title), title).toMatchObject({ eligible: false, reason });
    }
  });

  it('lets a front-office title outrank the reject that shares its words', () => {
    // Order is the whole design. Commercial banking and the back office are
    // tested before the front office because "Commercial Banking Intern" and
    // "Summer Analyst, Operations" would otherwise be claimed by it. Insurance,
    // tax and underwriting are tested after it, because there the overlap runs
    // the other way.
    expect(classifyFinanceCategory('2027 Blackstone Credit and Insurance, Private Credit Strategies Summer Analyst'))
      .toMatchObject({ category: 'PE/VC', eligible: true });
    expect(classifyFinanceCategory('Equity Capital Markets Underwriting Analyst')).toMatchObject({ category: 'IB', eligible: true });
    // JPMorgan writes "Commercial & Investment Bank" on an equity research
    // internship, which is one of the best rows the lists carry. The commercial
    // pattern requires the two words adjacent so that it survives.
    expect(classifyFinanceCategory('Commercial & Investment Bank - Markets Equity Research Internship'))
      .toMatchObject({ category: 'IB', eligible: true });
  });

  it('drops a role that is not early career, whatever desk it is on', () => {
    // Whole employer boards are read now, not student lists: BlackRock's is 250
    // postings of which two are internships. The student-title and graduation
    // filters are deliberately off for this profile, so seniority is the filter
    // that keeps a Vice President out of a digest of internships.
    for (const title of ['ETF Product Platform - BlackRock Global Markets, Vice President',
      'Managing Director, Investment Banking', 'Director, Portfolio Management', 'Senior Equity Research Analyst',
      'Head of Private Credit', 'Lead Investment Analyst', 'Portfolio Manager, Multi-Asset']) {
      expect(classifyFinanceCategory(title), title).toMatchObject({ eligible: false, reason: 'not_early_career' });
    }
  });

  it('keeps the early-career titles that merely sound senior', () => {
    // "principal investments" is private equity rather than a job level, and
    // neither "leadership" nor "management" is a seniority word.
    for (const title of ['Principal Investments Summer Analyst 2027', 'Financial Leadership Development Program Intern',
      'Internship in Portfolio Management', 'Investment Banking Analyst, Summer 2027']) {
      expect(classifyFinanceCategory(title), title).toMatchObject({ eligible: true });
    }
  });

  it('drops another discipline even when its description talks about trading', () => {
    // The trading firms' boards are shared with the technical digest and are
    // mostly software roles. Their descriptions say "proprietary trading", and
    // the description fallback used to read that as a finance signal: Chicago
    // Trading Company's software internship and IMC's machine learning
    // internship both reached this email.
    const description = 'Chicago Trading Company is a premier proprietary trading firm. Algorithmic trading, capital markets.';
    for (const title of ['Software Engineering Internship - Summer 2027', 'Machine Learning Research Intern - Summer 2027',
      'Summer Intern 2027 - Software Developer', 'Hardware Engineering Intern']) {
      expect(classifyFinanceCategory(title, description), title).toMatchObject({ eligible: false, reason: 'not_a_finance_discipline' });
    }
    // A quant title that names a markets role is not another discipline: those
    // patterns name their own discipline, so they are the only ones allowed to
    // keep a title another discipline also claims. A Quantitative Developer is
    // not one of them, and falls to this reject on the word "developer".
    expect(classifyFinanceCategory('Quantitative Developer Intern - Summer 2027', description)).toMatchObject({ eligible: false, reason: 'not_a_finance_discipline' });
    expect(classifyFinanceCategory('Campus Quantitative Researcher (Intern)', description)).toMatchObject({ category: 'Quant', eligible: true });
    expect(classifyFinanceCategory('Quantitative Trading Intern - Summer 2027', description)).toMatchObject({ category: 'Quant', eligible: true });
    // A software role that merely sits on an equities desk is still a software
    // role, even though "fundamental equities" is a buy-side phrase.
    expect(classifyFinanceCategory('Software Engineer - Fundamental Equities'))
      .toMatchObject({ eligible: false, reason: 'not_a_finance_discipline' });
  });

  it('reads only the front office out of a description, never the loose finance word', () => {
    // A title with no track of its own is the only one that earns a look at the
    // body, and every job description written at a financial firm says
    // "financial" somewhere inside it.
    expect(classifyFinanceCategory('2027 Summer Analyst Program', 'Join our investment banking division.')).toMatchObject({ category: 'IB', eligible: true });
    expect(classifyFinanceCategory('Campus Intern 2027', 'A financial services company with a strong finance function.'))
      .toMatchObject({ eligible: false, reason: 'no_finance_signal' });
  });

  it('reads financial planning and analysis as corporate finance, not wealth management', () => {
    // "Financial Planning" is a wealth-management title and "Financial Planning
    // & Analysis" is a corporate-finance one, and the two sit in different
    // sections of the email.
    expect(classifyFinanceCategory('Intern, Financial Planning - Los Altos, CA')).toMatchObject({ category: 'AM/WM' });
    expect(classifyFinanceCategory('Financial Planning & Analysis Intern')).toMatchObject({ category: 'Corp Fin' });
  });

  it('drops accounting, audit and tax', () => {
    // 602 of the 3,996 rows on the new-grad list and 57 of 100 on the
    // internship list, and none of them is a role this digest is for.
    for (const title of ['Accounting Intern', 'Internal Audit Internship - Summer 2027', 'Tax Internship - Summer 2027',
      'Accounts Payable Coordinator', 'Payroll Specialist', 'Staff Accountant', 'Financial Controller', 'Billing Analyst']) {
      expect(classifyFinanceCategory(title), title).toMatchObject({ eligible: false, reason: 'accounting_audit_or_tax' });
    }
  });

  it('reads a title that says both banking and tax as banking', () => {
    // Front office is tested before the accounting reject for this reason, and
    // corporate finance after it, which is also what keeps the looser "finance"
    // pattern from readmitting an accounting row.
    expect(classifyFinanceCategory('Investment Banking - Tax Advisory Analyst')).toMatchObject({ category: 'IB', eligible: true });
    expect(classifyFinanceCategory('Accounting and Finance Intern')).toMatchObject({ eligible: false, reason: 'accounting_audit_or_tax' });
  });

  it('does not reach for roles that are not finance at all', () => {
    for (const title of ['Software Engineer Intern', 'Marketing Intern', 'Mechanical Engineering Co-op']) {
      expect(classifyFinanceCategory(title), title).toMatchObject({ eligible: false, reason: 'not_a_finance_discipline' });
    }
    // And a title that names no discipline this digest has an opinion about
    // still has to fail, rather than fall through to something.
    for (const title of ['Warehouse Associate', 'Barista, Part Time', 'Summer Camp Counselor']) {
      expect(classifyFinanceCategory(title), title).toMatchObject({ eligible: false, reason: 'no_finance_signal' });
    }
  });
});

describe('open to a student or a new graduate, or not carried at all', () => {
  it('keeps internships, graduate programmes and entry-level roles', async () => {
    const { classifyEarlyCareer } = await import('../src/classification.js');
    for (const title of ['Finance Internship (Summer 2027)', 'Corporate Finance Intern', '2027 US Finance Summer Internship Program',
      'Investment Banking Summer Analyst', 'Campus Undergraduate Summer Internship Program', 'Entry Level Finance Opportunities',
      'Financial Leadership Development Program Intern', 'Equity Research Co-op', 'New Grad Investment Analyst',
      // A class year beside an analyst title is how campus hiring names itself
      // when it uses no other word for it.
      '2027 Harvest Analyst', 'Investment Banking Analyst - Energy (Summer 2027)']) {
      expect(classifyEarlyCareer(title), title).toMatchObject({ eligible: true });
    }
  });

  it('drops the experienced roles that name neither a seniority nor a cycle', async () => {
    const { classifyEarlyCareer } = await import('../src/classification.js');
    // These are the rows that kept reaching the digest: seniority rejects a Vice
    // President and a cycle filter would reject an internship, but "Certified
    // Financial Advisor" names neither and still wants years behind it.
    for (const title of ['Certified Financial Advisor', 'Private Wealth Management Investment Consultant',
      'Portfolio Analyst', 'Equity Research Associate, Consumer']) {
      expect(classifyEarlyCareer(title), title).toMatchObject({ eligible: false });
    }
  });

  it('reads a stated experience requirement as the disqualifier it is', async () => {
    const { classifyEarlyCareer } = await import('../src/classification.js');
    expect(classifyEarlyCareer('Investment Analyst', 'We are looking for 3+ years of relevant experience in credit.'))
      .toMatchObject({ eligible: false, evidence: expect.stringContaining('3+ years') });
    expect(classifyEarlyCareer('Investment Analyst', 'Requires 5 - 7 years experience across public markets.'))
      .toMatchObject({ eligible: false });
    // One year is common on entry-level postings that count an internship
    // towards it, so the floor starts at two.
    expect(classifyEarlyCareer('Investment Analyst', 'Internship experience preferred; 1 year of experience welcome.'))
      .toMatchObject({ eligible: true });
  });

  it('is required of the finance digest and of nothing else', () => {
    expect(rolePolicies.finance.requireEarlyCareer).toBe(true);
    // The technical digest already requires a student title and a target cycle,
    // which is the stricter test and makes this one redundant there.
    expect(rolePolicies.technical.requireEarlyCareer).toBe(false);
  });
});

describe('profile isolation', () => {
  it('leaves the technical rules alone', () => {
    // The finance lists are only fetched under the finance profile, but if one
    // ever reached the technical run its rows must still be rejected there.
    expect(classifyCategory('Investment Banking Summer Analyst')).toMatchObject({ eligible: false });
    expect(classifyCategory('Intern, Finance (Summer 2027)')).toMatchObject({ eligible: false });
    expect(rolePolicies.technical.classifyRole('Software Engineer Intern')).toMatchObject({ category: 'SWE', eligible: true });
  });

  it('requires a cycle, a student title and a graduation fit only of the technical digest', () => {
    expect(rolePolicies.technical).toMatchObject({ requireStudentRole: true, requireCycle: true, requireGraduationFit: true });
    // Both role types as they come: an internship names a cycle and a new-grad
    // analyst role names nothing, so requiring one would drop every full-time
    // row. The graduation filter encodes one candidate's window, not this one's.
    expect(rolePolicies.finance).toMatchObject({ requireStudentRole: false, requireCycle: false, requireGraduationFit: false });
  });

  it('refuses to run the finance pipeline against the technical database', async () => {
    // jobs.sent_at is one column and email_batches carries no recipient, so
    // sharing a database means the second reader never sees a role the first
    // was mailed.
    vi.resetModules();
    vi.stubEnv('JOB_PROFILE', 'finance');
    vi.stubEnv('FINANCE_EMAIL_TO', 'someone@example.edu');
    vi.stubEnv('FINANCE_DATABASE_URL', '');
    const { activeProfile, financeDatabaseConfigured, config } = await import('../src/config.js');
    expect(activeProfile).toBe('finance');
    expect(financeDatabaseConfigured).toBe(false);
    // The recipient is the point of the profile, so it must not fall back.
    expect(config.EMAIL_TO).toBe('someone@example.edu');
  });

  it('will not start the finance profile without a recipient of its own', async () => {
    vi.resetModules();
    vi.stubEnv('JOB_PROFILE', 'finance');
    vi.stubEnv('FINANCE_EMAIL_TO', '');
    await expect(import('../src/config.js')).rejects.toThrow('FINANCE_EMAIL_TO');
  });
});

describe('the Notion ledger', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is not written to by the finance profile', async () => {
    // Its first run filed 200 finance postings as pages in the technical
    // reader's ledger, the per-run cap, because the profile overrides the
    // database and the recipient but shares NOTION_DATABASE_ID.
    vi.resetModules();
    vi.stubEnv('JOB_PROFILE', 'finance');
    vi.stubEnv('FINANCE_EMAIL_TO', 'someone@example.edu');
    vi.stubEnv('NOTION_MIRROR_ENABLED', 'true');
    vi.stubEnv('NOTION_TOKEN', 'secret_test_token_value');
    const { mirrorNewPostings } = await import('../src/mirror.js');
    // Returns the empty result without reaching the database or Notion.
    await expect(mirrorNewPostings('run-1')).resolves.toEqual({ attempted: 0, created: 0, failed: 0 });
  });
});

describe('mark applied', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('renders the link for the technical digest and not for the finance one', async () => {
    vi.resetModules();
    // An earlier test in this file leaves JOB_PROFILE stubbed.
    vi.stubEnv('JOB_PROFILE', '');
    vi.stubEnv('MARK_APPLIED_SECRET', 'x'.repeat(32));
    vi.stubEnv('MARK_APPLIED_BASE_URL', 'https://example.test/mark-applied');
    const technical = await import('../src/applied.js');
    expect(technical.markAppliedUrl('7f1c9f2e-1111-4222-8333-444455556666')).toContain('sig=');

    // The webhook resolves the id against the technical database and files the
    // row in that reader's Notion ledger, so a finance id is unknown to it: the
    // click answered "nothing was changed" four times in the first email sent.
    vi.resetModules();
    vi.stubEnv('JOB_PROFILE', 'finance');
    vi.stubEnv('FINANCE_EMAIL_TO', 'someone@example.edu');
    const finance = await import('../src/applied.js');
    expect(finance.markAppliedUrl('7f1c9f2e-1111-4222-8333-444455556666')).toBeUndefined();
  });
});

describe('US-only, read strictly enough for a banking list', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('treats a bare Canadian province as foreign', () => {
    expect(classifyLocation('Toronto, ON')).toMatchObject({ eligible: false });
    expect(classifyLocation('Montreal, QC')).toMatchObject({ eligible: false });
    expect(classifyLocation('Vancouver, BC')).toMatchObject({ eligible: false });
    // The province test runs before the US one for this string: CA is also a US
    // state code, so the US test used to claim it for California.
    expect(classifyLocation('Toronto, ON, CA')).toMatchObject({ eligible: false });
  });

  it('still reads the US places those codes could be confused with', () => {
    // "Ontario, CA" is in California and "London, KY" is in Kentucky.
    for (const place of ['Ontario, CA', 'London, KY', 'Toronto, OH', 'New York, NY', 'Remote']) {
      expect(classifyLocation(place), place).toMatchObject({ eligible: true });
    }
  });
});

describe('a role this reader has already applied to', () => {
  it('matches a ledger row worded the way a person words it', async () => {
    const { titlesDescribeOneRole } = await import('../src/notion.js');
    // The complaint that started this: American Express arrived in digest after
    // digest while sitting in the Notion ledger as applied. Exact title
    // equality was the only test that fired, and a hand-filed row is almost
    // never worded exactly as the board words it.
    expect(titlesDescribeOneRole(
      'campus undergraduate summer internship program 2027 software engineer',
      'campus undergraduate summer internship 2027 software engineer')).toBe(true);
    expect(titlesDescribeOneRole('ai software engineer intern edge', 'ai software engineer intern')).toBe(true);
    expect(titlesDescribeOneRole('quantitative research intern', 'quantitative research intern')).toBe(true);
  });

  it('will not hide a role nobody applied to', async () => {
    const { titlesDescribeOneRole } = await import('../src/notion.js');
    // Measured against the real ledger: comparing only against the smaller set
    // let a short generic title match every longer specific one at the same
    // employer. Hiding a role this reader never applied to is the more
    // expensive mistake, so the overlap has to hold in both directions.
    expect(titlesDescribeOneRole('software engineer intern spring 2027', 'enterprise systems software engineer intern')).toBe(false);
    expect(titlesDescribeOneRole('machine learning engineer intern', 'agent evaluation evolution machine learning engineer intern')).toBe(false);
    expect(titlesDescribeOneRole('software engineer intern', 'software engineer intern tiktok search data infrastructure')).toBe(false);
    expect(titlesDescribeOneRole('deep learning computer architecture intern', 'nvidia 2027 internships computer architecture')).toBe(false);
  });
});

describe('which link the digest keeps when one role arrives twice', () => {
  it('ranks an employer form above a listing page', async () => {
    const { applyLinkRank } = await import('../src/normalization.js');
    expect(applyLinkRank('https://boards.greenhouse.io/x/jobs/1')).toBeGreaterThan(applyLinkRank('https://www.intern-list.com/x/role_1'));
    expect(applyLinkRank('https://ms.wd5.myworkdayjobs.com/en-US/External/job/x')).toBeGreaterThan(applyLinkRank('https://jobright.ai/jobs/info/abc'));
    expect(applyLinkRank('https://www.linkedin.com/jobs/view/123')).toBeGreaterThan(applyLinkRank('https://raw.githubusercontent.com/x/README.md'));
    expect(applyLinkRank(undefined)).toBe(0);
  });

  it('keeps the row that can be applied through, not merely the higher-scoring one', async () => {
    const { localDedupe } = await import('../src/pipeline.js');
    const base = {
      sourceName: 'x', company: 'Acme', location: 'Remote', scrapedAt: '2026-08-22T00:00:00.000Z',
      normalizedCompany: 'acme', normalizedTitle: 'software engineer intern', normalizedLocation: 'remote',
      category: 'SWE' as const, cycle: 'Summer 2027' as const, sponsorshipStatus: 'UNKNOWN' as const,
      sponsorshipEvidence: '', graduationEligible: true, graduationEvidence: '', requiredSkills: [], summary: ''
    };
    const listing = { ...base, title: 'Software Engineer Intern', sourceUrl: 'https://www.intern-list.com/swe/role_1',
      directApplyUrl: undefined, canonicalUrl: 'https://www.intern-list.com/swe/role_1', canonicalKey: 'a', score: 99 };
    const employer = { ...base, title: 'Software Engineer Intern', sourceUrl: 'https://example.test/list',
      directApplyUrl: 'https://boards.greenhouse.io/acme/jobs/42', canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/42', canonicalKey: 'b', score: 10 };
    const { unique } = localDedupe([listing, employer]);
    expect(unique).toHaveLength(1);
    expect(unique[0]?.directApplyUrl).toBe('https://boards.greenhouse.io/acme/jobs/42');
  });
});

describe('quant, split between the two digests', () => {
  it('sends a quantitative developer to the technical digest and not this one', () => {
    // A Quantitative Developer at a trading firm writes software. The reader of
    // this digest asked for roles that invest or research what to invest in.
    for (const title of ['Quantitative Developer Intern', 'Quantitative Engineer Intern', 'Quant Developer - Summer 2027']) {
      expect(classifyFinanceCategory(title), title).toMatchObject({ eligible: false, reason: 'not_a_finance_discipline' });
      expect(classifyCategory(title), title).toMatchObject({ category: 'Quant', eligible: true });
    }
  });

  it('keeps the quant roles that decide or study what to trade', () => {
    for (const title of ['Quantitative Researcher Intern', 'Quantitative Trader Intern', 'Quantitative Trading Internship',
      'Quantitative Analyst Intern', 'Quantitative Risk Intern', 'Algorithmic Trading Intern']) {
      expect(classifyFinanceCategory(title), title).toMatchObject({ category: 'Quant', eligible: true });
    }
  });
});

describe('which boards the finance reader gets', () => {
  const boards = JSON.parse(readFileSync(resolve(process.cwd(), 'config/sources.json'), 'utf8')).ats as Array<{ company: string; profile?: string }>;

  // PIMCO sat in the config tagged technical-only, so the finance run never
  // opened one of the largest asset managers there is, and its whole 2027
  // summer analyst class was invisible. Five more were tagged the same way.
  // A board's profile decides whether it is fetched at all, so a wrong tag
  // cannot be recovered downstream however good the classifier is.
  it('fetches the investment managers and trading firms for the finance reader', () => {
    const investors = ['PIMCO', 'LPL Financial Holdings', 'Optiver', 'Maven Securities',
      'Encephalo Investments', 'VWH Capital Management', 'Garda Capital Partners', 'Morningstar'];
    for (const company of investors) {
      const board = boards.find(entry => entry.company === company);
      expect(board, `${company} is missing from config/sources.json`).toBeDefined();
      expect(board?.profile, `${company} must be fetched for the finance reader`).not.toBe('technical');
    }
  });

  // The other half of the judgement: these are payments and consumer-fintech
  // companies, and between them they post 1,249 roles and not one the finance
  // digest wants. They stay technical so the finance run does not spend five
  // fetches to find nothing.
  it('leaves the fintechs to the technical reader', () => {
    for (const company of ['Stripe', 'Coinbase', 'Robinhood', 'Affirm', 'Plaid']) {
      const board = boards.find(entry => entry.company === company);
      if (board) expect(board.profile ?? 'technical', company).toBe('technical');
    }
  });
});
