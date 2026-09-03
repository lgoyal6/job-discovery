import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// What PostgreSQL will actually enforce. A later migration drops and re-adds the
// constraint, so the last definition in filename order is the live one.
function enforcedClaims(sql: string): string[] {
  const definitions = [...sql.matchAll(/graduation_claim\s+IN\s*\(([^)]*)\)/gi)];
  const live = definitions.at(-1);
  if (!live) throw new Error('no graduation_claim CHECK found in migrations');
  return [...live[1].matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
}

// Read as text because the union is a type: it does not exist at runtime, and
// the point of this test is that nothing else ties it to the schema.
function emittedClaims(source: string): string[] {
  const union = /export type ClaimedGraduation\s*=\s*([^;]+);/.exec(source);
  if (!union) throw new Error('ClaimedGraduation union not found in src/classification.ts');
  return [...union[1].matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
}

describe('database migrations', () => {
  // The classifier began emitting DECEMBER_2027 while migration 011 still
  // allowed only June 2027 and June 2028. PostgreSQL rejected the first
  // matching posting and aborted the entire scheduled discovery run. It stayed
  // broken for every run after it, because the offending posting was still
  // there, so two digests were lost before a migration widened the column.
  //
  // Compares the two lists rather than looking for today's value, so adding a
  // fourth claim to either side without the other fails here instead of in a
  // scheduled run hours later.
  it('allows exactly the graduation claims classification emits', async () => {
    const directory = resolve(process.cwd(), 'migrations');
    const files = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort();
    const sql = (await Promise.all(files.map(file => readFile(resolve(directory, file), 'utf8')))).join('\n');
    const source = await readFile(resolve(process.cwd(), 'src/classification.ts'), 'utf8');

    expect(enforcedClaims(sql)).toEqual(emittedClaims(source));
  });
});
