import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import noMagicTokens from './tools/eslint/no-magic-tokens.js';
import noOffscaleTokens from './tools/eslint/no-offscale-tokens.js';
import requireFocusRing from './tools/eslint/require-focus-ring.js';

/** Local, project-specific rules that enforce the UI Design System contract. */
const tagnest = {
  rules: {
    'no-magic-tokens': noMagicTokens,
    'no-offscale-tokens': noOffscaleTokens,
    'require-focus-ring': requireFocusRing,
  },
};

export default tseslint.config(
  {
    ignores: [
      'dist',
      'dist_*',
      'dist-bak-*',
      'dist-stale-*',
      'dist-verify',
      'dist-ext',
      'dist-ext/**',
      'node_modules',
      '.wrangler',
      '.tmp-push',
      'parser.bundle.mjs',
      '_tmp_test_parser.mjs',
      'push-t*.mjs',
      'verify-t*.mjs',
      'diff-t*.mjs',
      'tmp-*.mjs',
      'scripts',
      'extension',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The PWA service worker runs in a dedicated browser worker scope.
    files: ['public/*.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
        Clients: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Event: 'readonly',
        FetchEvent: 'readonly',
        ExtendableEvent: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, tagnest },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // UI Design System v2 gate — tightened to 'error' in T15 now that the
      // accumulated backlog has been cleared batch by batch (T01–T14). The
      // three rules below are the contract; `npm run lint` carries
      // --max-warnings=0 so any new violation fails CI outright.
      //
      // T01 note: these three rules previously emitted 0 messages because
      // no-magic-tokens could not see `cx(...)`. After the fix they surfaced
      // the accumulated debt — 209 warnings across 44 files (84 + 36 + 89, see
      // "附录 C：T01 门禁基线" in docs/ui-design-system-audit.md). T02–T14
      // cleared that backlog to 0; T15 flips the severity so it cannot regrow.
      'tagnest/no-magic-tokens': 'error',
      'tagnest/no-offscale-tokens': 'error',
      'tagnest/require-focus-ring': 'error',
    },
  },
  {
    // Decision D2: `--shadow-xs` / `--shadow-sm` are demoted to a private
    // ladder owned by CategoryView.css. CategoryView.tsx is the only .tsx
    // consumer (2 sites), so it is exempted from the off-scale check rather
    // than forced onto shadow-raised and made inconsistent with its own CSS.
    files: ['src/components/library/CategoryView.tsx'],
    rules: { 'tagnest/no-offscale-tokens': 'off' },
  },
  {
    // The lint rules and their RuleTester suite are plain Node ESM scripts, so
    // they need the Node globals (`console`, `process`, …). Without this block
    // `no-undef` from js.configs.recommended flags the suite's success line.
    files: ['tools/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  {
    // Vitest test files (backend + UI) use the vitest globals; without this
    // eslint's `no-undef` flags describe/it/expect/vi.
    files: ['**/*.{test,spec}.{ts,tsx}'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
  },
);
