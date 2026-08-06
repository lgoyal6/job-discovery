import { defineConfig } from 'vitest/config';

// EMAIL_TO and the Notion ids are required with no default, so that a missing
// value fails at startup rather than silently pointing production at whatever
// was baked into the source. Tests still need *some* value, so supply obviously
// fake ones here — never real workspace ids, which is how they leaked before.
export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
  },
});
