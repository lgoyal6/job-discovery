import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ClassifiedJob, DigestJob } from '../src/types.js';

/**
 * Two questions the schema could not answer.
 *
 * "What did the digest that went out on Tuesday say about this role?" The jobs
 * row is rewritten in place on every pass, so by Thursday it says something
 * else, and email_batches recorded only which ids were in the mail.
 *
 * "This role is gone; is it gone everywhere?" It was not. job_sources and
 * job_enrichment cascade, but email_batches.job_ids is a uuid[] with no
 * foreign key, sponsorship_overrides and applied_exclusions key on the apply
 * URL rather than the job id, and the Notion page lives in another system
 * entirely. A hand-run DELETE left all four.
 */

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const suite = enabled ? describe : describe.skip;

function posting(suffix: string, overrides: Partial<ClassifiedJob> = {}): ClassifiedJob {
  return {
    sourceName: `provenance:${suffix}`, sourceJobId: suffix,
    title: 'Software Engineer Intern Summer 2027', company: `Acme ${suffix}`,
    location: 'Remote', description: 'Python internship',
    sourceUrl: `https://example.test/jobs/${suffix}`, directApplyUrl: `https://example.test/jobs/${suffix}`,
    scrapedAt: new Date().toISOString(),
    canonicalKey: suffix.replaceAll('-', '').padEnd(64, '0').slice(0, 64),
    canonicalUrl: `https://example.test/jobs/${suffix}`,
    normalizedCompany: `acme ${suffix}`, normalizedTitle: 'software engineer intern summer 2027',
    normalizedLocation: 'remote', category: 'SWE', cycle: 'Summer 2027',
    sponsorshipStatus: 'UNKNOWN', sponsorshipEvidence: 'not stated',
    graduationEligible: true, graduationEvidence: 'eligible',
    requiredSkills: ['Python'], score: 100, summary: 'Python internship', status: 'OPEN',
    ...overrides
  } as ClassifiedJob;
}

suite('an emailed digest is traceable to the version it was built from', () => {
  it('records the material version as it stood when the batch was claimed, not as it stands now', async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = await import('../src/db.js');
    const suffix = randomUUID();

    const { job } = await db.upsertJob(posting(suffix));
    const versionAtSend = await db.pool.query<{ material_version: number }>('SELECT material_version FROM jobs WHERE id=$1', [job.id]);
    const sentVersion = versionAtSend.rows[0]?.material_version;

    const runId = db.newRunId();
    const { batchKey } = await db.prepareEmailBatch(runId, [{ id: job.id } as DigestJob], 'Digest');

    // The requisition is retitled and moved, which is what bumps the version.
    await db.upsertJob(posting(suffix, { title: 'Software Engineer Intern (Systems) Summer 2027', location: 'New York, NY', normalizedLocation: 'new york ny' }));
    const now = await db.pool.query<{ material_version: number }>('SELECT material_version FROM jobs WHERE id=$1', [job.id]);

    expect(now.rows[0]?.material_version).toBeGreaterThan(sentVersion!);

    const recorded = await db.pool.query<{ material_version: number; material_fingerprint: string }>(
      'SELECT material_version, material_fingerprint FROM email_batch_jobs WHERE batch_key=$1 AND job_id=$2', [batchKey, job.id]);
    // The output still points at the input that produced it.
    expect(recorded.rows[0]?.material_version).toBe(sentVersion);
    expect(recorded.rows[0]?.material_version).not.toBe(now.rows[0]?.material_version);
  }, 30_000);
});

suite('a role that has been forgotten stops appearing anywhere', () => {
  it('leaves nothing in the caches, the batch arrays, or the ledger cache, and hands back the export', async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = await import('../src/db.js');
    const suffix = randomUUID();
    const applyUrl = `https://example.test/jobs/${suffix}`;
    const sharedListing = `https://example.test/list-${suffix}/README.md`;

    const { job } = await db.upsertJob(posting(suffix, { sourceUrl: sharedListing }));
    const jobId = job.id;
    if (!jobId) throw new Error('upsertJob returned a row with no id');
    await db.saveEnrichment([{ jobId, status: 'UNSUPPORTED', evidence: 'no sponsorship', sourceUrl: applyUrl, httpOk: true }]);
    await db.pool.query(
      `INSERT INTO outbox(idempotency_key, topic, payload) VALUES($1, 'notion.ledger.page', $2::jsonb)`,
      [`mirror:${jobId}`, JSON.stringify({ jobId, company: job.company, title: job.title, url: applyUrl, status: 'Found' })]
    );
    await db.recordNotionPage(jobId, `notion-${suffix}`);

    // A batch that also carries an unrelated role, so the scrub has to be
    // surgical rather than a rewrite of the array.
    const other = await db.upsertJob(posting(randomUUID()));
    const { batchKey } = await db.prepareEmailBatch(db.newRunId(), [{ id: job.id } as DigestJob, { id: other.job.id } as DigestJob], 'Digest');

    // The two caches that key on the apply URL rather than the job id.
    await db.pool.query(
      `INSERT INTO sponsorship_overrides(company_normalized, canonical_url, status, evidence) VALUES($1,$2,'UNSUPPORTED','manual')`,
      [`acme ${suffix}`, applyUrl]);
    await db.recordLedgerExclusion({
      notionPageId: `notion-${suffix}`, companyNormalized: `acme ${suffix}`,
      titleNormalized: 'software engineer intern summer 2027', canonicalUrl: applyUrl, sourceJobId: suffix, kind: 'APPLIED'
    });

    const result = await db.forgetJob(jobId);

    expect(result.found).toBe(true);
    // The export lives in Notion, which no transaction here can reach, so the
    // handle comes back rather than being quietly abandoned.
    expect(result.notionPageId).toBe(`notion-${suffix}`);
    expect(result.removed.sources).toBeGreaterThan(0);
    expect(result.removed.enrichment).toBe(1);
    expect(result.removed.batchProvenance).toBe(1);
    expect(result.removed.batchIdReferences).toBe(1);
    expect(result.removed.sponsorshipOverrides).toBe(1);
    expect(result.removed.ledgerExclusions).toBe(1);
    expect(result.removed.outboxMessages).toBe(1);

    const gone = async (sql: string, params: unknown[]): Promise<number> => (await db.pool.query(sql, params)).rowCount ?? 0;
    expect(await gone('SELECT 1 FROM jobs WHERE id=$1', [job.id])).toBe(0);
    expect(await gone('SELECT 1 FROM job_sources WHERE job_id=$1', [job.id])).toBe(0);
    expect(await gone('SELECT 1 FROM job_enrichment WHERE job_id=$1', [job.id])).toBe(0);
    expect(await gone('SELECT 1 FROM email_batch_jobs WHERE job_id=$1', [job.id])).toBe(0);
    expect(await gone('SELECT 1 FROM sponsorship_overrides WHERE canonical_url=$1', [applyUrl])).toBe(0);
    expect(await gone('SELECT 1 FROM applied_exclusions WHERE canonical_url=$1', [applyUrl])).toBe(0);
    expect(await gone("SELECT 1 FROM outbox WHERE payload->>'jobId'=$1", [job.id])).toBe(0);
    // The uuid[] with no foreign key: this is the one a plain DELETE leaves.
    expect(await gone('SELECT 1 FROM email_batches WHERE $1::uuid = ANY(job_ids)', [job.id])).toBe(0);

    // Surgical: the role that shared the batch is untouched.
    const survivors = await db.pool.query<{ job_ids: string[] }>('SELECT job_ids FROM email_batches WHERE batch_key=$1', [batchKey]);
    expect(survivors.rows[0]?.job_ids).toEqual([other.job.id]);
    expect(await gone('SELECT 1 FROM jobs WHERE id=$1', [other.job.id])).toBe(1);

    // A later source pass must not recreate or re-export the forgotten role.
    const reingested = await db.upsertJob(posting(suffix));
    expect(reingested.forgotten).toBe(true);
    expect(reingested.job.id).toBeUndefined();
    expect(await gone('SELECT 1 FROM jobs WHERE canonical_key=$1', [job.canonicalKey])).toBe(0);
    expect(await gone("SELECT 1 FROM outbox WHERE payload->>'jobId'=$1", [job.id])).toBe(0);
    expect(await gone('SELECT 1 FROM forgotten_jobs WHERE canonical_key=$1', [job.canonicalKey])).toBe(1);

    // A community feed URL is shared by many roles and is not a tombstone key.
    const siblingSuffix = randomUUID();
    const sibling = await db.upsertJob(posting(siblingSuffix, { sourceUrl: sharedListing }));
    expect(sibling.forgotten).not.toBe(true);
    expect(sibling.job.id).toBeDefined();
  }, 30_000);

  it('reports a role it has never heard of rather than claiming to have removed one', async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = await import('../src/db.js');
    const result = await db.forgetJob(randomUUID());
    expect(result.found).toBe(false);
    expect(result.notionPageId).toBeUndefined();
  }, 30_000);
});
