import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { writeGraduationClaim } from '../src/db.js';
import { writeGraduationClaimV11 } from './fixtures/graduation-writer-v11.js';

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)('expand-contract migration rollout', () => {
  it('keeps the old writer valid, accepts the new value, and preserves data after a failed rollback', async () => {
    const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
    const client = await pool.connect();
    const schema = `migration_rollout_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}", public`);
      const files = (await readdir(resolve(process.cwd(), 'migrations')))
        .filter(name => name.endsWith('.sql')).sort();

      for (const file of files.filter(name => name <= '011_graduation_claim.sql')) {
        await client.query(await readFile(resolve(process.cwd(), 'migrations', file), 'utf8'));
      }

      // Seed identities, then exercise the retained previous service writer.
      const oldRow = await client.query<{ id: string }>(
        `INSERT INTO jobs(canonical_key,company,normalized_company,title,normalized_title,
                          normalized_location,cycle,category,sponsorship_status)
         VALUES('old','Old Writer','old writer','Engineer','engineer','remote','Summer 2027','SWE','UNKNOWN')
         RETURNING id`
      );
      const oldAfter = await client.query<{ id: string }>(
        `INSERT INTO jobs(canonical_key,company,normalized_company,title,normalized_title,
                          normalized_location,cycle,category,sponsorship_status)
         VALUES('old-after','Old Writer','old writer','Engineer II','engineer ii','remote','Summer 2027','SWE','UNKNOWN')
         RETURNING id`
      );
      const currentRow = await client.query<{ id: string }>(
        `INSERT INTO jobs(canonical_key,company,normalized_company,title,normalized_title,
                          normalized_location,cycle,category,sponsorship_status)
         VALUES('new','New Writer','new writer','Engineer','engineer','remote','Summer 2027','SWE','UNKNOWN')
         RETURNING id`
      );
      await writeGraduationClaimV11(client, oldRow.rows[0]!.id, 'JUNE_2027');

      await client.query(await readFile(resolve(process.cwd(), 'migrations/012_december_2027_graduation_claim.sql'), 'utf8'));

      // The old writer still works after expansion, while the new writer can use
      // the added value.
      await writeGraduationClaimV11(client, oldAfter.rows[0]!.id, 'JUNE_2027');
      await writeGraduationClaim(client, currentRow.rows[0]!.id, 'DECEMBER_2027');

      // A mistaken contraction cannot validate against the new row. Its whole
      // transaction rolls back, leaving the expanded constraint and all rows.
      await client.query('BEGIN');
      await client.query('ALTER TABLE jobs DROP CONSTRAINT jobs_graduation_claim_check');
      await expect(client.query(
        `ALTER TABLE jobs ADD CONSTRAINT jobs_graduation_claim_check
         CHECK (graduation_claim IN ('JUNE_2027','JUNE_2028'))`
      )).rejects.toThrow();
      await client.query('ROLLBACK');

      const repaired = await client.query<{ graduation_claim: string }>(
        `SELECT graduation_claim FROM jobs WHERE id=$1 OR id=$2 ORDER BY canonical_key`,
        [oldRow.rows[0]!.id, currentRow.rows[0]!.id]
      );
      expect(repaired.rows.map(row => row.graduation_claim).sort()).toEqual(['DECEMBER_2027', 'JUNE_2027']);
      await writeGraduationClaim(client, oldAfter.rows[0]!.id, 'DECEMBER_2027');
    } finally {
      await client.query('RESET search_path').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  }, 30_000);
});
