/**
 * Recompute, from the restored rows, the columns the pipeline derives.
 *
 * The SQL checks ask whether the database still enforces what it used to. This
 * asks a different question: whether the values in the restored rows are still
 * the values this code would produce from them. normalized_company,
 * normalized_title, normalized_location, material_fingerprint and
 * canonical_key are all functions of columns sitting in the same row, so every
 * one of them is checkable without trusting anything the restore said.
 *
 * material_fingerprint is the one that matters most. It decides whether a role
 * counts as changed, a changed role used to have its send state cleared, and
 * that is how 125 already-emailed roles were queued to be emailed again. A
 * restore that brought fingerprints back subtly wrong would do the same thing
 * again, and no row count would show it.
 *
 *   DATABASE_URL=... npx tsx scripts/restore-verify.ts
 */
import { pool } from '../src/db.js';
import {
  buildAliasMap, canonicalKey, canonicalLocation, canonicalizeUrl,
  materialFingerprint, normalizeCompany, normalizeText
} from '../src/normalization.js';

interface Row {
  canonical_key: string; company: string; normalized_company: string;
  title: string; normalized_title: string; location: string; normalized_location: string;
  cycle: string; material_fingerprint: string;
  source_name: string | null; source_job_id: string | null; source_url: string | null;
  sources: string;
}

const failures: Record<string, number> = {};
const examples: Record<string, string> = {};
function check(name: string, ok: boolean, detail: string): void {
  failures[name] ??= 0;
  if (!ok) { failures[name]++; examples[name] ??= detail; }
}

async function main(): Promise<void> {
  const aliasRows = await pool.query<{ alias_normalized: string; canonical_company: string }>(
    'SELECT alias_normalized, canonical_company FROM company_aliases');
  const aliases = buildAliasMap(Object.fromEntries(
    aliasRows.rows.map(row => [row.canonical_company, [row.alias_normalized]])));

  const { rows } = await pool.query<Row>(`
    SELECT j.canonical_key, j.company, j.normalized_company, j.title, j.normalized_title,
           j.location, j.normalized_location, j.cycle, j.material_fingerprint,
           s.source_name, s.source_job_id, s.source_url,
           (SELECT count(*) FROM job_sources t WHERE t.job_id = j.id)::text AS sources
      FROM jobs j
      LEFT JOIN LATERAL (
        SELECT source_name, source_job_id, source_url FROM job_sources
         WHERE job_id = j.id ORDER BY created_at, id LIMIT 1) s ON true`);

  for (const row of rows) {
    check('normalized_company recomputes',
      normalizeCompany(row.company, aliases).normalized === row.normalized_company,
      `${row.company} -> ${normalizeCompany(row.company, aliases).normalized} stored ${row.normalized_company}`);
    check('normalized_title recomputes',
      normalizeText(row.title) === row.normalized_title,
      `${row.title} -> ${normalizeText(row.title)} stored ${row.normalized_title}`);
    check('normalized_location recomputes',
      canonicalLocation(row.location) === row.normalized_location,
      `${row.location} -> ${canonicalLocation(row.location)} stored ${row.normalized_location}`);
    check('material_fingerprint recomputes',
      materialFingerprint({ title: row.title, location: row.location, cycle: row.cycle }) === row.material_fingerprint,
      `${row.title} | ${row.location} | ${row.cycle}`);
    if (Number(row.sources) === 1 && row.source_name && row.source_url) {
      const recomputed = canonicalKey({
        sourceName: row.source_name, sourceJobId: row.source_job_id ?? undefined,
        canonicalUrl: canonicalizeUrl(row.source_url),
        normalizedCompany: row.normalized_company, normalizedTitle: row.normalized_title,
        normalizedLocation: row.normalized_location, cycle: row.cycle
      });
      check('canonical_key recomputes', recomputed === row.canonical_key,
        `${row.source_name}/${row.source_job_id} -> ${recomputed.slice(0, 12)} stored ${row.canonical_key.slice(0, 12)}`);
    }
  }

  console.log(`rows recomputed: ${rows.length}`);
  let bad = 0;
  for (const [name, count] of Object.entries(failures)) {
    console.log(`${count === 0 ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} mismatches ${count}${count ? `  e.g. ${examples[name]}` : ''}`);
    bad += count;
  }
  await pool.end();
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(error => { console.error(error); process.exit(2); });
