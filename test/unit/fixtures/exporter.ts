import type { Exporter } from '../../../src/diplomat/cli/io.js';

/** For a CLI harness whose commands never export: any use is a bug in the test. */
export const unusedExporter: Exporter = {
  databasePath: () => {
    throw new Error('exporter used');
  },
  provenKey: () => Promise.reject(new Error('exporter used')),
  writeSnapshot: () => Promise.reject(new Error('exporter used')),
};
