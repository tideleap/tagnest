import { defineConfig } from 'vitest/config';

// Backend unit tests run in plain Node — no DOM, no React. They exercise the
// pure logic of the Pages Functions (URL normalisation, import parsers, id
// encoding, auth primitives) without needing a live D1 instance.
export default defineConfig({
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
