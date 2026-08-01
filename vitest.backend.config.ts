import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Backend unit tests run in plain Node — no DOM, no React. They exercise the
// pure logic of the Pages Functions (URL normalisation, import parsers, id
// encoding, auth primitives) without needing a live D1 instance.
export default defineConfig({
  // A few front-end modules are pure enough to test here (the API client's
  // timeout and error classification need no DOM), so the same path aliases
  // the app uses must resolve.
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
    coverage: {
      provider: 'v8',
      include: ['functions/_lib/**/*.ts'],
      exclude: ['functions/_lib/env.ts'],
    },
  },
});
