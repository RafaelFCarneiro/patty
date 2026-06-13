import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'integration',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 30_000,
    reporters: ['default', 'verbose'],
  },
})
