import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ClassifiedJob } from '../src/types.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const suite = enabled ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Every case here is one that actually arrived twice. They drive the real SQL,
// one upsert per pipeline run with a send in between, because all four failures
// are about what the database remembers between runs rather than about what any
// single run computes. In-run dedupe already collapsed all of these; that is
// exactly why the repeat showed up a day later instead of in the same digest.
// ---------------------------------------------------------------------------
suite('a role that has been emailed does not come back', () => {
  const base = (suffix: string): ClassifiedJob => ({
    sourceName: 'apify:monster', sourceJobId: `monster-${suffix}`, title: '2027 Software Engineer Intern',
    company: `Tiktok ${suffix}`, location: 'Atlanta, GA', description: 'A role', sourceUrl: `https://monster.test/${suffix}`,
    directApplyUrl: `https://monster.test/${suffix}`, scrapedAt: new Date().toISOString(),
    canonicalKey: `k1${suffix}`.replaceAll('-', '').padEnd(64, '0').slice(0, 64), canonicalUrl: `https://monster.test/${suffix}`,
    normalizedCompany: `tiktok ${suffix}`, normalizedTitle: '2027 software engineer intern', normalizedLocation: 'atlanta ga',
    category: 'SWE', cycle: 'Summer 2027', sponsorshipStatus: 'UNKNOWN', sponsorshipEvidence: 'not stated',
    graduationEligible: true, graduationEvidence: 'eligible', requiredSkills: [], score: 99, summary: 'A role', status: 'OPEN'
  });

  const sendDigest = async (db: typeof import('../src/db.js'), job: { id?: string }): Promise<void> => {
    const batch = await db.prepareEmailBatch(randomUUID(), [job as never], `subject ${randomUUID()}`);
    expect(batch.claimed).toBe(true);
    expect(await db.markBatchSent(batch.batchKey)).toBe(true);
  };

  // Dies if the requisition-level suppression is removed from the pipeline, or
  // if the key it groups by stops matching the one the digest groups rows by.
  it('suppresses a second row for a requisition already emailed', async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = await import('../src/db.js');
    const { dropAlreadySentRequisitions } = await import('../src/pipeline.js');
    const suffix = randomUUID();
    const first = await db.upsertJob(base(suffix));
    await sendDigest(db, first.job);

    // The next day, through a different list: its own requisition id, its own
    // apply link, its own wording. Nothing the upsert can key on.
    const second = await db.upsertJob({
      ...base(suffix), sourceName: 'linkedin', sourceJobId: `li-${suffix}`,
      title: 'Software Engineer Intern, 2027', normalizedTitle: 'software engineer intern 2027',
      canonicalKey: `k2${suffix}`.replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      sourceUrl: `https://linkedin.test/${suffix}`, directApplyUrl: `https://linkedin.test/${suffix}`, canonicalUrl: `https://linkedin.test/${suffix}`
    });
    expect(second.job.id).not.toBe(first.job.id);
    expect((await db.getUnsentJobIds([second.job.id!])).size).toBe(1);

    const sent = await db.getSentRequisitions([`tiktok ${suffix}`]);
    const result = dropAlreadySentRequisitions([second.job], sent);
    expect(result.suppressed).toBe(1);
    expect(result.kept).toHaveLength(0);
  });

  // Dies if the requisition-id clause is dropped from the upsert's identity
  // lookup. A canonical key prefixes the source name, so without that clause
  // one posting reached through a board and through a list that links to it is
  // two rows and two emails.
  it('merges one requisition id that arrived through two different sources', async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = await import('../src/db.js');
    const suffix = randomUUID();
    const first = await db.upsertJob({ ...base(suffix), sourceJobId: `5148079007-${suffix}` });
    await sendDigest(db, first.job);

    const second = await db.upsertJob({
      ...base(suffix), sourceName: 'greenhouse:andurilindustries', sourceJobId: `5148079007-${suffix}`,
      title: 'Software Engineer Intern 2027', normalizedTitle: 'software engineer intern 2027',
      canonicalKey: `k3${suffix}`.replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      sourceUrl: `https://boards.test/${suffix}`, directApplyUrl: `https://boards.test/${suffix}`, canonicalUrl: `https://boards.test/${suffix}`
    });
    expect(second.job.id).toBe(first.job.id);
    expect((await db.getUnsentJobIds([second.job.id!])).size).toBe(0);
  });

  // Dies if absence is treated as closure again. The board actors sample a
  // capped, rotating slice, so a high-volume employer's role drops out of the
  // sample, closes at 72 hours, returns unchanged, and used to be mailed again.
  it('does not re-email a role that merely fell out of a capped scrape', async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = await import('../src/db.js');
    const suffix = randomUUID();
    const first = await db.upsertJob(base(suffix));
    await sendDigest(db, first.job);

    await db.pool.query("UPDATE jobs SET last_seen_at = now() - interval '80 hours' WHERE id=$1", [first.job.id]);
    await db.pool.query("UPDATE job_sources SET scraped_at = now() - interval '80 hours' WHERE job_id=$1", [first.job.id]);
    await db.closeStaleJobs();

    const seenAgain = await db.upsertJob(base(suffix));
    expect((await db.getUnsentJobIds([seenAgain.job.id!])).size).toBe(0);
  });

  // An absence no sampling gap explains is still a repost worth an email.
  it('does re-email a role that was genuinely gone for months', async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = await import('../src/db.js');
    const suffix = randomUUID();
    const first = await db.upsertJob(base(suffix));
    await sendDigest(db, first.job);

    await db.pool.query("UPDATE jobs SET status='CLOSED', closed_at = now() - interval '120 days' WHERE id=$1", [first.job.id]);
    const reposted = await db.upsertJob(base(suffix));
    expect(reposted.stateChanged).toBe(true);
    expect((await db.getUnsentJobIds([reposted.job.id!])).size).toBe(1);
  });

  // Dies if the material fingerprint goes back to raw title and location text.
  // Two lists spelling one city or one title differently is not a change to
  // tell an applicant about, but it used to clear sent_at on the next run.
  it('does not re-email because a second list spells the city or title differently', async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = await import('../src/db.js');
    const suffix = randomUUID();
    const first = await db.upsertJob(base(suffix));
    await sendDigest(db, first.job);

    const restated = await db.upsertJob({
      ...base(suffix), title: 'Software Engineer Intern, 2027', normalizedTitle: 'software engineer intern 2027',
      location: 'Atlanta, Georgia, United States', normalizedLocation: 'atlanta ga'
    });
    expect(restated.job.id).toBe(first.job.id);
    expect((await db.getUnsentJobIds([restated.job.id!])).size).toBe(0);
  });

  // The counterpart: a real change still reaches the inbox.
  it('still re-emails when the role itself changes', async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = await import('../src/db.js');
    const suffix = randomUUID();
    const first = await db.upsertJob(base(suffix));
    await sendDigest(db, first.job);

    const moved = await db.upsertJob({ ...base(suffix), location: 'Austin, TX', normalizedLocation: 'austin tx' });
    expect(moved.job.id).toBe(first.job.id);
    expect((await db.getUnsentJobIds([moved.job.id!])).size).toBe(1);
  });
});
