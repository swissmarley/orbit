// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Security invariants enforced at lint time (see docs/decisions/ADR-005 and ADR-006).
 * The same invariants are re-checked across all file types by tools/guards/*.test.ts.
 */
const credentialSelectors = [
  {
    selector: 'Literal[value=/\\.credentials\\.json/]',
    message:
      'Orbit must never reference Claude OAuth credential files (ADR-005). Only the official `claude` binary touches them.',
  },
  {
    selector: 'TemplateElement[value.raw=/\\.credentials\\.json/]',
    message:
      'Orbit must never reference Claude OAuth credential files (ADR-005). Only the official `claude` binary touches them.',
  },
  {
    selector: 'Literal[value=/Claude Code-credentials/]',
    message: 'Orbit must never read the Claude Code keychain entry (ADR-005).',
  },
];

const envSelectors = [
  {
    selector:
      "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='CLAUDE_CODE_OAUTH_TOKEN']",
    message:
      'Never read CLAUDE_CODE_OAUTH_TOKEN (ADR-005). Use the audited presence helper in @orbit/runtime.',
  },
  {
    selector:
      "MemberExpression[object.object.name='process'][object.property.name='env'][property.value='CLAUDE_CODE_OAUTH_TOKEN']",
    message:
      'Never read CLAUDE_CODE_OAUTH_TOKEN (ADR-005). Use the audited presence helper in @orbit/runtime.',
  },
  {
    selector: "SpreadElement[argument.object.name='process'][argument.property.name='env']",
    message:
      'Child processes must not inherit process.env wholesale (ADR-005). Build the env from an allowlist.',
  },
];

const modelIdSelectors = [
  {
    selector: 'Literal[value=/^claude-(opus|sonnet|haiku|fable|mythos)-\\d/]',
    message: 'Model IDs come from config, never source (ADR-006). Use aliases or ORBIT_*_MODEL.',
  },
  {
    selector: 'TemplateElement[value.raw=/claude-(opus|sonnet|haiku|fable|mythos)-\\d/]',
    message: 'Model IDs come from config, never source (ADR-006). Use aliases or ORBIT_*_MODEL.',
  },
];

const testGlobs = ['**/*.test.ts', '**/*.test.tsx', '**/test/**', '**/__tests__/**'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/storybook-static/**',
      '**/src-tauri/target/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        { ignoreArrowShorthand: true, ignoreVoidReturningFunctions: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': [
        'error',
        ...credentialSelectors,
        ...envSelectors,
        ...modelIdSelectors,
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    // Tests may name credential files and model IDs (to prove we never touch them),
    // but still may not read the OAuth token or leak process.env.
    files: testGlobs,
    rules: {
      'no-restricted-syntax': ['error', ...envSelectors],
      '@typescript-eslint/no-non-null-assertion': 'off',
      // fakes are async generators that may not await; generic JSON helpers are fine in tests
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // This file defines the restricted patterns, so it necessarily contains them.
    files: ['eslint.config.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  prettier,
);
