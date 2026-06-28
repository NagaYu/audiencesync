// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

/**
 * Flat ESLint config for AudienceSync.
 *
 * - Type-aware linting via typescript-eslint's `recommendedTypeChecked` rules.
 * - `eslint-config-prettier` LAST so Prettier owns all formatting decisions and ESLint never
 *   reports formatting conflicts.
 */
export default tseslint.config(
  {
    // Never lint build output, deps, coverage, or the flat-config file itself (it's plain JS and
    // not part of the TS project, so type-aware rules can't resolve it).
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'eslint.config.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Enable type-aware rules. Use a dedicated tsconfig that also includes test/** so test
        // files get type information (the build tsconfig only includes src/**).
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow intentionally-unused identifiers when prefixed with `_` (e.g. exhaustiveness guards).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // We use `void`-free async deliberately; keep the rest of the recommended set as-is.
    },
  },
  {
    // Test files: relax type-aware strictness around expect() chains and fixtures.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  // Must come last to disable stylistic rules that would fight Prettier.
  eslintConfigPrettier,
);
