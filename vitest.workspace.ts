export default [
  'vitest.unit.config.ts',
  {
    test: {
      name: 'mcp',
      include: ['test/integration/mcp/**/*.test.ts'],
      testTimeout: 30_000,
      globalSetup: 'test/integration/setup.ts',
      setupFiles: ['test/integration/mcp/setup.ts'],
      fileParallelism: false,
    },
  },
  {
    test: {
      name: 'http',
      include: ['test/integration/http/**/*.test.ts'],
      testTimeout: 30_000,
      globalSetup: 'test/integration/setup.ts',
      fileParallelism: false,
    },
  },
  {
    test: {
      name: 'general',
      include: ['test/integration/*.test.ts'],
      testTimeout: 30_000,
      globalSetup: 'test/integration/setup.ts',
      fileParallelism: false,
    },
  },
]
