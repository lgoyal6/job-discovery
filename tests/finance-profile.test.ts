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
      ['FP&A Internship - Summer 2027', 'Corp Fin'],
      ['Intern, Finance (Summer 2027)', 'Corp Fin'],
      ['Credit Analyst - Spring/Summer 2027', 'Corp Fin']
    ];
    for (const [title, category] of cases) {
      expect(classifyFinanceCategory(title), title).toMatchObject({ category, eligible: true });
    }
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
