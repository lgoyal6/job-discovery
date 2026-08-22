import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { ClassifiedJob } from '../src/types.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const suite = enabled ? describe : describe.skip;

suite('PostgreSQL persistence integration', () => {
  it('merges duplicates, claims one email batch, and re-emails a repost but not a sampling gap', async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = await import('../src/db.js');
    const suffix = randomUUID();
    const base: ClassifiedJob = {
      sourceName: `integration:${suffix}`, sourceJobId: suffix, title: 'Software Engineer Intern Summer 2027', company: `Acme ${suffix}`,
      location: 'Remote', description: 'Python internship', sourceUrl: `https://example.test/jobs/${suffix}`, directApplyUrl: `https://example.test/jobs/${suffix}`,
      scrapedAt: new Date().toISOString(), canonicalKey: suffix.replaceAll('-', '').padEnd(64, '0').slice(0, 64), canonicalUrl: `https://example.test/jobs/${suffix}`,
      normalizedCompany: `acme ${suffix}`, normalizedTitle: 'software engineer intern summer 2027', normalizedLocation: 'remote', category: 'SWE', cycle: 'Summer 2027',
      sponsorshipStatus: 'UNKNOWN', sponsorshipEvidence: 'not stated', graduationEligible: true, graduationEvidence: 'eligible', requiredSkills: ['Python'], score: 100, summary: 'Python internship', status: 'OPEN'
    };
    const first = await db.upsertJob(base);
    const duplicate = await db.upsertJob({ ...base, sourceName: `linkedin:${suffix}`, sourceJobId: `li-${suffix}` });
    expect(first.isNew).toBe(true);
    expect(duplicate.isNew).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);

    const firstBatch = await db.prepareEmailBatch(randomUUID(), [first.job], `test ${suffix}`);
    const sameBatch = await db.prepareEmailBatch(randomUUID(), [first.job], `test ${suffix}`);
    expect(firstBatch.claimed).toBe(true);
    expect(sameBatch.claimed).toBe(false);
    expect(await db.markBatchSent(firstBatch.batchKey, `message-${suffix}`)).toBe(true);

    // Closing and reopening inside the sampling window is the scrape losing
    // sight of the role, not a repost, so the send must survive it.
    await db.upsertJob({ ...base, status: 'CLOSED' });
    const reopened = await db.upsertJob({ ...base, status: 'OPEN' });
    expect(reopened.stateChanged).toBe(false);
    expect((await db.getUnsentJobIds([reopened.job.id!])).has(reopened.job.id!)).toBe(false);

    // An absence no sampling gap explains still earns a second email.
    await db.pool.query("UPDATE jobs SET status='CLOSED', closed_at = now() - interval '120 days' WHERE id=$1", [reopened.job.id]);
    const reposted = await db.upsertJob({ ...base, status: 'OPEN' });
    expect(reposted.stateChanged).toBe(true);
    expect((await db.getUnsentJobIds([reposted.job.id!])).has(reposted.job.id!)).toBe(true);

    const apifySource = `apify:test:${suffix}`;
    expect(await db.isSourceDue(apifySource, 24)).toBe(true);
    const now = new Date().toISOString();
    await db.recordSourceRuns(randomUUID(), [{ sourceName: apifySource, status: 'SUCCESS', jobs: [], startedAt: now, finishedAt: now, durationMs: 0, costUnits: 0 }]);
    expect(await db.isSourceDue(apifySource, 24)).toBe(false);
    expect(await db.isSourceDue(apifySource, 24, new Date(Date.now() + 25 * 3_600_000))).toBe(true);
    const watermarkBefore = await db.pool.query<{ updated_at: Date }>('SELECT updated_at FROM pipeline_watermarks WHERE source_name=$1', [apifySource]);
    await db.recordSourceRuns(randomUUID(), [{ sourceName: apifySource, status: 'SUCCESS', jobs: [], startedAt: now, finishedAt: now, durationMs: 0, costUnits: 0, metrics: { skippedDueToCadence: true } }]);
    const watermarkAfter = await db.pool.query<{ updated_at: Date }>('SELECT updated_at FROM pipeline_watermarks WHERE source_name=$1', [apifySource]);
    expect(watermarkAfter.rows[0]?.updated_at.getTime()).toBe(watermarkBefore.rows[0]?.updated_at.getTime());

    // The mirror queue is "never written to Notion", so a role leaves it the
    // moment its page id is stored. Without that, every run rewrites every
    // posting and the ledger fills with duplicates.
    const queued = await db.getJobsToMirror(500);
    expect(queued.some(row => row.id === first.job.id)).toBe(true);
    await db.recordNotionPage(first.job.id!, `notion-page-${suffix}`);
    expect((await db.getJobsToMirror(500)).some(row => row.id === first.job.id)).toBe(false);
    expect((await db.getJobForLedger(first.job.id!))?.notionPageId).toBe(`notion-page-${suffix}`);

    let releaseLock!: () => void;
    let confirmLock!: () => void;
    const lockStarted = new Promise<void>(resolve => { confirmLock = resolve; });
    const holdLock = new Promise<void>(resolve => { releaseLock = resolve; });
    const firstLock = db.withPipelineLock(async () => { confirmLock(); await holdLock; });
    await lockStarted;
    await expect(db.withPipelineLock(async () => undefined)).rejects.toThrow('already active');
    releaseLock();
    await firstLock;
    await db.pool.end();
  });
});

suite('a source row migrating between job rows', () => {
  it('re-points it without colliding with the row this job already has', async () => {
    // This is what took the technical digest down for eighteen hours. Every
    // community list gives all of its rows the same README as source_url, so
    // when a posting migrated from one job row to another, the upsert tried to
    // move (old job, README) onto (this job, README) and hit
    // job_sources_job_id_source_url_key against the row it had just inserted
    // itself. The run aborted before it could claim an email batch, and since
    // the migration is re-attempted from the same state every two hours it
    // failed identically ten runs in a row.
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = await import('../src/db.js');
    const suffix = randomUUID();
    const readme = `https://example.test/list-${suffix}/README.md`;
    const listRow = (id: string, title: string): ClassifiedJob => ({
      sourceName: `list:${suffix}`, sourceJobId: id, title, company: `Employer ${id}`,
      location: 'Remote', sourceUrl: readme, directApplyUrl: `https://boards.example.test/jobs/${id}`,
      scrapedAt: new Date().toISOString(), canonicalKey: id.replaceAll('-', '').padEnd(64, 'a').slice(0, 64),
      canonicalUrl: `https://boards.example.test/jobs/${id}`, normalizedCompany: `employer ${id}`,
      normalizedTitle: title.toLowerCase(), normalizedLocation: 'remote', category: 'SWE', cycle: 'Summer 2027',
      sponsorshipStatus: 'UNKNOWN', sponsorshipEvidence: 'not stated', graduationEligible: true,
      graduationEvidence: 'eligible', requiredSkills: [], score: 50, summary: title, status: 'OPEN'
    });

    // Two distinct jobs off one list, so both hold a job_sources row for the
    // same README.
    const alpha = await db.upsertJob(listRow(`alpha-${suffix}`, 'Alpha Intern Summer 2027'));
    const beta = await db.upsertJob(listRow(`beta-${suffix}`, 'Beta Intern Summer 2027'));
    expect(alpha.job.id).not.toBe(beta.job.id);

    // Now alpha's requisition id arrives under beta's identity, which is the
    // migration: the same source and source_job_id, resolving to the other job.
    const migrated = await db.upsertJob({
      ...listRow(`alpha-${suffix}`, 'Beta Intern Summer 2027'),
      canonicalKey: beta.job.canonicalKey,
      normalizedCompany: beta.job.normalizedCompany,
      normalizedTitle: beta.job.normalizedTitle
    });
    // The point of the test is that this resolved at all rather than throwing.
    expect(migrated.job.id).toBe(beta.job.id);
    await db.pool.end();
  });
});

suite('a fingerprint that flip-flops between sources', () => {
  it('does not mail the role again inside the cooldown', async () => {
    // Production had material_version 83 on one Netic internship, 55 and 54 on
    // Belvedere's, 30 on Anduril's, every one of them fed by more than one
    // source. Each source writes its own spelling of the title and location to
    // the same row, so the fingerprint flipped every run, sent_at was cleared,
    // and the role was mailed again. That is 83 copies of one role.
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = await import('../src/db.js');
    const suffix = randomUUID();
    const base: ClassifiedJob = {
      sourceName: `board:${suffix}`, sourceJobId: suffix, title: 'Software Engineer Intern', company: `Churn ${suffix}`,
      location: 'San Francisco, CA', sourceUrl: `https://example.test/${suffix}`, directApplyUrl: `https://example.test/${suffix}`,
      scrapedAt: new Date().toISOString(), canonicalKey: suffix.replaceAll('-', '').padEnd(64, 'b').slice(0, 64),
      canonicalUrl: `https://example.test/${suffix}`, normalizedCompany: `churn ${suffix}`,
      normalizedTitle: 'software engineer intern', normalizedLocation: 'san francisco ca', category: 'SWE', cycle: 'Summer 2027',
      sponsorshipStatus: 'UNKNOWN', sponsorshipEvidence: '', graduationEligible: true, graduationEvidence: '',
      requiredSkills: [], score: 50, summary: '', status: 'OPEN'
    };
    const first = await db.upsertJob(base);
    const batch = await db.prepareEmailBatch(randomUUID(), [first.job], `churn ${suffix}`);
    await db.markBatchSent(batch.batchKey, `msg-${suffix}`);

    // A second source describing the same role in its own words.
    await db.upsertJob({ ...base, sourceName: `list:${suffix}`, title: 'Software Engineer Intern - Summer 2027', location: 'SF' });
    const unsent = await db.getUnsentJobIds([first.job.id!]);
    expect(unsent.has(first.job.id!)).toBe(false);
    await db.pool.end();
  });
});

afterAll(() => undefined);
