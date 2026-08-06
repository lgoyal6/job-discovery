import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { ClassifiedJob } from '../src/types.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const suite = enabled ? describe : describe.skip;

suite('PostgreSQL persistence integration', () => {
  it('merges duplicates, claims one email batch, and re-emails Closed to Open', async () => {
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

    await db.upsertJob({ ...base, status: 'CLOSED' });
    const reopened = await db.upsertJob({ ...base, status: 'OPEN' });
    expect(reopened.stateChanged).toBe(true);
    expect((await db.getUnsentJobIds([reopened.job.id!])).has(reopened.job.id!)).toBe(true);

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

afterAll(() => undefined);
