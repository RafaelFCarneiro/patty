import tseslint from 'typescript-eslint';

/** Shared by every `no-restricted-syntax` block below (a later block replaces, not merges, the earlier one). */
const SWITCH_TOO_LARGE = {
  selector: 'SwitchStatement > SwitchCase:nth-child(7)',
  message:
    'More than 6 cases: use an exhaustive `satisfies Record<Kind, …>` table (docs/code-quality.md § Function shape)',
};

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
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      // Dead imports/locals/params are how an unused `authenticate` import and a never-called `principalOf`
      // reached review. A leading underscore marks a deliberately unused binding (e.g. a positional callback
      // argument); `args: 'after-used'` only flags parameters AFTER the last one that is used.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // A type is imported as a type, and one module is imported once — `import { a, type B } from 'm'`.
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      'no-duplicate-imports': 'error',
      // Declarative over imperative (docs/code-quality.md, remeda table): the `xs.filter(...)[0]`
      // smell — taking the first match by index instead of R.find / R.firstBy.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[computed=true][property.type='Literal'][property.value=0] > CallExpression[callee.property.name='filter']",
          message: 'Avoid `xs.filter(...)[0]` — use R.find / R.firstBy (see docs/code-quality.md remeda table).',
        },
        SWITCH_TOO_LARGE,
      ],
      // ADR-007: in stdio mode stdout carries the MCP protocol — human logging must go to stderr.
      // console.error / console.warn (stderr) are allowed; console.log (stdout) is not.
      'no-console': ['error', { allow: ['error', 'warn'] }],
      // docs/code-style.md: const + expressions over let + mutation.
      'prefer-const': 'error',
      // Strict equality, except the idiomatic `== null` / `!= null` null-ish guard.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'max-len': [
        'error',
        {
          code: 120,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
        },
      ],
    },
  },
  {
    // Declarative layers: no loops, `let` or `.push(` (docs/code-quality.md remeda table). Restates the base filter()[0] and switch-size selectors because a later no-restricted-syntax replaces, not merges.
    files: ['src/logic/**/*.ts', 'src/controllers/**/*.ts', 'src/adapters/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[computed=true][property.type='Literal'][property.value=0] > CallExpression[callee.property.name='filter']",
          message: 'Avoid `xs.filter(...)[0]` — use R.find / R.firstBy (see docs/code-quality.md remeda table).',
        },
        SWITCH_TOO_LARGE,
        ...[
          ['ForStatement', 'a `for` loop'],
          ['ForOfStatement', 'a `for…of` loop'],
          ['ForInStatement', 'a `for…in` loop'],
          ['WhileStatement', 'a `while` loop'],
          ['DoWhileStatement', 'a `do…while` loop'],
        ].map(([selector, what]) => ({
          selector,
          message: `Avoid ${what} here — use R.map / R.filter / R.reduce / R.pipe or a pure helper (docs/code-quality.md remeda table).`,
        })),
        {
          selector: 'VariableDeclaration[kind="let"]',
          message:
            'Avoid `let` here — use `const` and expressions (R.pipe, R.reduce, a scan; docs/code-quality.md remeda table).',
        },
        {
          selector: 'CallExpression[callee.property.name="push"]',
          message:
            'Avoid `.push(` here — build the array as one expression (spread, R.map, R.flatMap; docs/code-quality.md remeda table).',
        },
      ],
    },
  },
  {
    // An edge's vocabulary stays at that edge: tool names are the MCP edge's (docs/architecture.md § Diplomat edge organization).
    files: ['src/**/*.ts', 'test/**/*.ts'],
    ignores: ['src/diplomat/mcp/**', 'test/unit/diplomat/mcp/**', 'test/unit/docs/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/diplomat/mcp/tool-name.js'],
              message:
                "ToolName is the MCP edge's vocabulary — a domain error carries a `Remedy`; diplomat/mcp translates it.",
            },
          ],
        },
      ],
    },
  },
  {
    // Function shape (docs/code-quality.md § Function shape).
    files: ['src/**/*.ts'],
    rules: {
      'max-lines-per-function': ['error', { max: 40, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 10],
      'max-depth': ['error', 3],
      'max-statements': ['error', 15],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      'max-len': [
        'error',
        {
          code: 120,
          ignoreUrls: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
        },
      ],
    },
  },
);
