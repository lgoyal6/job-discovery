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
    // A quant title is not another discipline: the quant patterns name their
    // own discipline, so they are the only ones allowed to keep a title that
    // another discipline also claims.
    expect(classifyFinanceCategory('Quantitative Developer Intern - Summer 2027', description)).toMatchObject({ category: 'Quant', eligible: true });
    expect(classifyFinanceCategory('Campus Quantitative Researcher (Intern)', description)).toMatchObject({ category: 'Quant', eligible: true });
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
