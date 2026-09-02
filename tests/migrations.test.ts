import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('database migrations', () => {
  it('allows every graduation claim emitted by classification', async () => {
    const directory = resolve(process.cwd(), 'migrations');
    const files = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort();
    const sql = (await Promise.all(files.map(file => readFile(resolve(directory, file), 'utf8')))).join('\n');

    // The classifier began emitting DECEMBER_2027 while migration 011 still
    // allowed only June 2027 and June 2028. PostgreSQL rejected the first
    // matching posting and aborted the entire scheduled discovery run.
    expect(sql).toMatch(/jobs_graduation_claim_check[\s\S]*DECEMBER_2027/);
  });
});
