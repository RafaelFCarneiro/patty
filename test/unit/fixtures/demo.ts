import { err } from 'neverthrow';
import type { DemoShell } from '../../../src/diplomat/cli/io.js';
import { demoFailures, DemoFailureCode } from '../../../src/models/demo/core.js';

export const unusedDemo: DemoShell = {
  databasePath: '/unused/demo.db',
  hasDatabase: () => false,
  prepare: () => Promise.reject(new Error('demo used')),
  serve: () => Promise.resolve(err(demoFailures.of(DemoFailureCode.enum.port_in_use))),
};
