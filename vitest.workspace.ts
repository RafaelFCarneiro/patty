import { defineProject } from 'vitest/config';

export default [
  'vitest.unit.config.ts',
  defineProject({
    test: {
      name: 'mcp',
      include: ['test/integration/mcp/**/*.test.ts'],
      testTimeout: 30_000,
      globalSetup: 'test/integration/setup.ts',
      setupFiles: ['test/integration/mcp/setup.ts'],
      fileParallelism: false,
    },
  }),
  defineProject({
    test: {
      name: 'http',
      include: ['test/integration/http/**/*.test.ts'],
      testTimeout: 30_000,
      globalSetup: 'test/integration/setup.ts',
      fileParallelism: false,
    },
  }),
  defineProject({
    test: {
      name: 'general',
      include: ['test/integration/*.test.ts'],
      testTimeout: 30_000,
      globalSetup: 'test/integration/setup.ts',
      fileParallelism: false,
    },
  }),
];
