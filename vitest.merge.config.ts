export default {
  test: {
    include: [],
    coverage: {
      provider: 'v8',
      mergeReports: 'coverage/.tmp',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
    },
  },
};
