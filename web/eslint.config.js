import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// Guardrails (Ruling F2; eslint.config.test.mjs proves each one).
const MOCK_IMPORTS = {
  regex: '(^|/)mocks(/|$)|^msw(/|$)',
  message:
    'Mock data never ships: only src/mocks, the guarded import in src/main.tsx and tests may use it.',
}
const OPENAPI_FETCH = {
  group: ['openapi-fetch', 'openapi-fetch/*'],
  message:
    'Use api from src/api/client: it adds the CSRF token, the 401 handling and strict call types.',
}
const restrictImports = (...patterns) => ['error', { patterns }]

// The network and browser storage: only the API client (src/api), the live
// stream (src/live), the mock and the tests reach them.
const NETWORK_AND_STORAGE = [
  'fetch',
  'XMLHttpRequest',
  'EventSource',
  'localStorage',
  'sessionStorage',
  'indexedDB',
]
const NETWORK_MESSAGE =
  'Use api from src/api/client (or the live stream in src/live); session data never goes in browser storage.'
const restrictGlobals = (names) => [
  'error',
  ...names.map((name) => ({ name, message: NETWORK_MESSAGE })),
]
const restrictProperties = (names) => [
  'error',
  ...['window', 'globalThis', 'self'].flatMap((object) =>
    names.map((property) => ({ object, property, message: NETWORK_MESSAGE })),
  ),
]
// Appearance and the sidebar's non-sensitive pin setting are browser UI state;
// public/theme.js also reads the appearance cache before the app loads.
const EXCEPT_LOCAL_STORAGE = NETWORK_AND_STORAGE.filter((name) => name !== 'localStorage')
// Post-sign-in intro plays once per sign-in in the same tab via a non-sensitive sessionStorage flag.
const EXCEPT_SESSION_STORAGE = NETWORK_AND_STORAGE.filter((name) => name !== 'sessionStorage')
// A service worker forwards navigations with fetch but must not store or cache
// anything: fetch is allowed in public/sw.js, and the Cache API is banned there too.
const SERVICE_WORKER = [...NETWORK_AND_STORAGE.filter((name) => name !== 'fetch'), 'caches']

const TESTS = ['**/*.test.{ts,tsx}', '**/*.test-d.ts', 'vitest.setup.ts', 'e2e/**', 'e2e-live/**']

export default tseslint.config(
  {
    ignores: [
      'dist',
      'dist-mock',
      'shots',
      'test-results',
      'test-results-live',
      'playwright-report',
      'playwright-report-live',
      'src/api/schema.d.ts',
      'src/routeTree.gen.ts',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.{js,mjs}', 'vite.config.ts'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },

  // Imports. A later block replaces an earlier block's options for the same rule.
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': restrictImports(MOCK_IMPORTS, OPENAPI_FETCH),
      // no-restricted-imports does not see import(); a page must not load the mock that way either.
      // (\x2F is "/": a selector's regex cannot contain a slash.)
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression[source.value=/(^|\\x2F)mocks(\\x2F|$)|^msw(\\x2F|$)/]',
          message: MOCK_IMPORTS.message,
        },
      ],
    },
  },
  {
    files: ['src/api/**'],
    rules: { 'no-restricted-imports': restrictImports(MOCK_IMPORTS) },
  },
  {
    files: ['src/mocks/**', 'src/main.tsx', ...TESTS],
    rules: {
      'no-restricted-imports': restrictImports(OPENAPI_FETCH),
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['src/api/**/*.test.{ts,tsx}', 'src/api/**/*.test-d.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // The network and browser storage.
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['src/api/**', 'src/live/**', 'src/mocks/**', 'scripts/**', ...TESTS],
    rules: {
      'no-restricted-globals': restrictGlobals(NETWORK_AND_STORAGE),
      'no-restricted-properties': restrictProperties(NETWORK_AND_STORAGE),
    },
  },
  {
    files: ['src/lib/appearance.ts', 'src/routes/_app.tsx', 'public/**/*.js'],
    rules: {
      'no-restricted-globals': restrictGlobals(EXCEPT_LOCAL_STORAGE),
      'no-restricted-properties': restrictProperties(EXCEPT_LOCAL_STORAGE),
    },
  },
  {
    files: ['src/auth/intro-flag.ts'],
    rules: {
      'no-restricted-globals': restrictGlobals(EXCEPT_SESSION_STORAGE),
      'no-restricted-properties': restrictProperties(EXCEPT_SESSION_STORAGE),
    },
  },
  // public/: plain scripts the browser runs as they are (not bundled).
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { sourceType: 'script', globals: globals.serviceworker },
    rules: {
      'no-restricted-globals': restrictGlobals(SERVICE_WORKER),
      'no-restricted-properties': restrictProperties(SERVICE_WORKER),
    },
  },
)
