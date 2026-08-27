import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import noMagicTokens from './tools/eslint/no-magic-tokens.js';

/** Local, project-specific rules that enforce the UI Design System contract. */
const tagnest = { rules: { 'no-magic-tokens': noMagicTokens } };

export default tseslint.config(
  {
    ignores: [
      'dist',
      'dist_*',
      'dist-bak-*',
      'dist-ext',
      'dist-ext/**',
      'node_modules',
      '.wrangler',
      'parser.bundle.mjs',
      '_tmp_test_parser.mjs',
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
      // UI Design System v2 gate — warn only for now; tighten to 'error' once
      // the existing backlog has been cleared in later stages.
      'tagnest/no-magic-tokens': 'warn',
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
