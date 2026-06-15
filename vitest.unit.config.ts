import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'unit',
    include: ['test/unit/**/*.test.ts'],
    testTimeout: 5_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/diplomat/**', 'src/wire/**'],
      reporter: ['text', 'html', 'json'],
      reportsDirectory: 'coverage/.tmp/unit',
    },
  },
})
