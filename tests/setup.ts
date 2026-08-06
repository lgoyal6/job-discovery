// Fake-but-well-formed values for the config fields that have no default.
// Only fills what is unset, so scripts/test-e2e.sh can still point the suite at
// a real throwaway database via DATABASE_URL.
const testEnv: Record<string, string> = {
  EMAIL_TO: 'test@example.com',
  NOTION_DATABASE_ID: '00000000000000000000000000000000',
  NOTION_DATA_SOURCE_ID: '00000000-0000-0000-0000-000000000000',
};

for (const [key, value] of Object.entries(testEnv)) {
  if (!process.env[key]) process.env[key] = value;
}
