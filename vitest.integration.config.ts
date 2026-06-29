import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'integration',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 30_000,
    reporters: ['default', 'verbose'],
    globalSetup: 'test/integration/setup.ts',
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'mcp',
          include: ['test/integration/mcp/**/*.test.ts'],
          setupFiles: ['test/integration/mcp/setup.ts'],
        },
      },
      {
        test: {
          name: 'http',
          include: ['test/integration/http/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'general',
          include: ['test/integration/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/diplomat/**', 'src/wire/**'],
      reporter: ['json'],
      reportsDirectory: 'coverage/.tmp/integration',
    },
  },
})
