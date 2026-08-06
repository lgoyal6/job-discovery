import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const suite = enabled ? describe : describe.skip;
let db: typeof import('../src/db.js');
let runPipeline: typeof import('../src/pipeline.js').runPipeline;

suite('complete fixture-to-email-batch pipeline', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.SEND_EMAIL_ENABLED = 'true';
    process.env.APIFY_ENABLED = 'false';
    process.env.PAID_SOURCES_ENABLED = 'false';
    vi.resetModules();
    db = await import('../src/db.js');
    ({ runPipeline } = await import('../src/pipeline.js'));
    await db.migrate();
  });

  it('persists, filters, deduplicates, claims once, confirms, and suppresses repeats', async () => {
    const first = await runPipeline({ fixtures: true, persistent: true });
    expect(first).toMatchObject({ dryRun: false, shouldSend: true, notionModified: false });
    expect(first.counts).toMatchObject({ raw: 7, accepted: 3, rejected: 3, deduplicated: 1 });
    expect(first.batchKey).toBeTruthy();
    expect(first.jobs.map(job => job.sponsorshipStatus).sort()).toEqual(['SUPPORTED', 'SUPPORTED', 'UNKNOWN']);

    expect(await db.markBatchSent(first.batchKey!, 'mock-gmail-message-id')).toBe(true);
    expect(await db.markBatchSent(first.batchKey!, 'duplicate-confirmation')).toBe(false);

    const second = await runPipeline({ fixtures: true, persistent: true });
    expect(second.shouldSend).toBe(false);
    expect(second.batchKey).toBeNull();
    expect(second.counts.accepted).toBe(0);
    expect(second.jobs).toHaveLength(0);

    const batches = await db.pool.query<{ status: string; provider_message_id: string }>("SELECT status,provider_message_id FROM email_batches WHERE provider_message_id='mock-gmail-message-id'");
    expect(batches.rows).toEqual([{ status: 'SENT', provider_message_id: 'mock-gmail-message-id' }]);
    const unsupportedSent = await db.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM jobs WHERE sponsorship_status='UNSUPPORTED' AND sent_at IS NOT NULL");
    expect(unsupportedSent.rows[0]?.count).toBe('0');
  });
});

afterAll(async () => {
  if (db) await db.pool.end();
});
