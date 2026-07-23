import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'integration',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 30_000,
    // Matches testTimeout — a `beforeAll` that seeds fixture data over real MCP round-trips (e.g.
    // pagination.test.ts's 120-row import) can take as long as a test body; the 10s Vitest default
    // left it with near-zero margin under ordinary CI runner variance (observed 9.5-10.1s even on
    // green runs), causing intermittent "Hook timed out" failures unrelated to the code under test.
    hookTimeout: 30_000,
    reporters: ['default', 'verbose'],
    globalSetup: 'test/integration/setup.ts',
    setupFiles: ['test/integration/mcp/setup.ts'],
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/diplomat/**', 'src/wire/**'],
      reporter: ['json'],
      reportsDirectory: 'coverage/.tmp/integration',
    },
  },
});
