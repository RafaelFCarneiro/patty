import tseslint from 'typescript-eslint'

/**
 * Lean, high-signal lint config. It machine-enforces the *precisely lintable* slice of
 * `docs/code-quality.md` / `docs/code-style.md`. Judgment-based rules that can't be linted
 * reliably (constants-over-literals, when a remeda pipeline beats native map/filter, naming,
 * single-responsibility) stay in the CLAUDE.md "Definition of Done" self-review — not here.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'drizzle/**', 'scripts/**', '**/*.config.ts', '**/*.config.js'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { sourceType: 'module' },
    },
    rules: {
      // Declarative over imperative (docs/code-quality.md, remeda table): the `xs.filter(...)[0]`
      // smell — taking the first match by index instead of R.find / R.firstBy.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[computed=true][property.type='Literal'][property.value=0] > CallExpression[callee.property.name='filter']",
          message:
            'Avoid `xs.filter(...)[0]` — use R.find / R.firstBy (see docs/code-quality.md remeda table).',
        },
      ],
      // ADR-007: in stdio mode stdout carries the MCP protocol — human logging must go to stderr.
      // console.error / console.warn (stderr) are allowed; console.log (stdout) is not.
      'no-console': ['error', { allow: ['error', 'warn'] }],
      // docs/code-style.md: const + expressions over let + mutation.
      'prefer-const': 'error',
      // Strict equality, except the idiomatic `== null` / `!= null` null-ish guard.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
)
