import { fileURLToPath } from 'node:url';

// Fake-but-well-formed values for the config fields that have no default.
// Only fills what is unset, so scripts/test-e2e.sh can still point the suite at
// a real throwaway database via DATABASE_URL.
const testEnv: Record<string, string> = {
  EMAIL_TO: 'test@example.com',
  NOTION_DATABASE_ID: '00000000000000000000000000000000',
  NOTION_DATA_SOURCE_ID: '00000000-0000-0000-0000-000000000000',
  // Not a fake: the real file, at the path a checkout has it rather than the
  // one the deployed layout has. Without this both pipeline tests fail on a
  // developer machine for a reason that has nothing to do with the test.
  WATCHLIST_PATH: fileURLToPath(new URL('../automation/job-company-watchlist.md', import.meta.url)),
};

for (const [key, value] of Object.entries(testEnv)) {
  if (!process.env[key]) process.env[key] = value;
}
