import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Front-end component tests run in a DOM environment (happy-dom) with
// @testing-library/react. They exercise real components — the theme picker,
// bookmark cards, import progress, dashboard metrics — so regressions in UI
// behaviour are caught automatically instead of relying on manual clicks.
//
// Colocated with the components they test (`src/**/*.test.tsx`), separate from
// the backend suite (`tests/**/*.test.ts`, see vitest.backend.config.ts).
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: [fileURLToPath(new URL('./src/test/setup.ts', import.meta.url))],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
    },
  },
});
