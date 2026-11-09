import type { Exporter, Importer } from '../../../src/diplomat/cli/io.js';

/** For a CLI harness whose commands never export: any use is a bug in the test. */
export const unusedExporter: Exporter = {
  databasePath: () => {
    throw new Error('exporter used');
  },
  provenKey: () => Promise.reject(new Error('exporter used')),
  writeSnapshot: () => Promise.reject(new Error('exporter used')),
};

export const unusedImporter: Importer = {
  databasePath: () => {
    throw new Error('importer used');
  },
  keySources: () => Promise.reject(new Error('importer used')),
  proveAgainstDatabase: () => Promise.reject(new Error('importer used')),
  storeKey: () => Promise.reject(new Error('importer used')),
  resolveKey: () => Promise.reject(new Error('importer used')),
  inspectSnapshot: () => Promise.reject(new Error('importer used')),
  stageSnapshot: () => Promise.reject(new Error('importer used')),
  publishSnapshot: () => Promise.reject(new Error('importer used')),
  discardSnapshot: () => {
    throw new Error('importer used');
  },
};
