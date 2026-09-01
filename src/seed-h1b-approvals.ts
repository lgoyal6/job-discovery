// Seed employer_h1b_approvals from the USCIS H-1B Employer Data Hub export.
//
// Usage: node dist/cli.js seed-h1b <path-to-h1b.json>
//
// The file is {source, fiscal_years, min_approvals, employers: {name: count}}.
// Employer names are keyed through normalizeCompany with the same alias map the
// pipeline uses, so a lookup at classify time matches on the identical key.
import { readFileSync } from 'node:fs';
import { pool } from './db.js';
import { buildAliasMap, normalizeCompany } from './normalization.js';
import { loadCompanyAliases } from './config.js';
import { log } from './logger.js';

interface Export { source: string; fiscal_years: number[]; employers: Record<string, number> }

export async function seed(path: string): Promise<{ inserted: number; collapsed: number }> {
  const data = JSON.parse(readFileSync(path, 'utf8')) as Export;
  const aliases = buildAliasMap(await loadCompanyAliases());

  // Two raw names can normalize to one key ("Acme Inc" and "Acme Corp"). Keep
  // the larger count rather than whichever arrived last.
  const merged = new Map<string, number>();
  let collapsed = 0;
  for (const [raw, count] of Object.entries(data.employers)) {
    const key = normalizeCompany(raw, aliases).normalized;
    if (!key) continue;
    const prior = merged.get(key);
    if (prior !== undefined) collapsed += 1;
    merged.set(key, Math.max(prior ?? 0, count));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE employer_h1b_approvals');
    const entries = [...merged.entries()];
    for (let i = 0; i < entries.length; i += 1000) {
      const chunk = entries.slice(i, i + 1000);
      const values = chunk.map((_, n) => `($${n * 4 + 1},$${n * 4 + 2},$${n * 4 + 3},$${n * 4 + 4})`).join(',');
      await client.query(
        `INSERT INTO employer_h1b_approvals(company_normalized,approvals,fiscal_years,source) VALUES ${values}`,
        chunk.flatMap(([key, count]) => [key, count, data.fiscal_years, data.source]));
    }
    await client.query('COMMIT');
    log('info', 'h1b_seed', { inserted: merged.size, collapsed, source: data.source, fiscalYears: data.fiscal_years });
    return { inserted: merged.size, collapsed };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
