import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [],
    coverage: {
      provider: 'v8',
      mergeReports: 'coverage/.tmp',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
    },
  },
})
