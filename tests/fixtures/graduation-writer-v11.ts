import type pg from 'pg';

/** The deployed writer before migration 012 expanded the accepted vocabulary. */
export async function writeGraduationClaimV11(
  client: Pick<pg.PoolClient, 'query'>,
  jobId: string,
  claim: 'JUNE_2027' | 'JUNE_2028'
): Promise<void> {
  await client.query('UPDATE jobs SET graduation_claim=$2 WHERE id=$1', [jobId, claim]);
}
