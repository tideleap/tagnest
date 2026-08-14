import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Fast backend unit tests — pure logic only, no database layer (not even the
// in-memory D1 mock). They run in plain Node with a single fork per file and
// exit in seconds, so they are safe to run on every commit / in the deploy
// gate without the full suite's footprint or its pool-parallelism hangs.
//
// The excluded files pull in `functions/_lib/db` (directly or via `_support/
// dbMock`), which is the slice that benefits from the slower, DB-backed run
// (`npm test`). Keep this list in sync with the DB-referencing tests.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    exclude: [
      'tests/ai-jobs.test.ts',
      'tests/apikeys.test.ts',
      'tests/auth-password.test.ts',
      'tests/category-private.test.ts',
      'tests/collections.test.ts',
      'tests/import-preview-endpoint.test.ts',
      'tests/private.test.ts',
      'tests/throttle.test.ts',
    ],
    pool: 'forks',
    fileParallelism: false,
  },
});
