import { err } from 'neverthrow';
import type { DemoShell } from '../../../src/diplomat/cli/io.js';
import { demoFailures, DemoFailureCode } from '../../../src/models/demo.js';

/** For a CLI harness whose commands never touch the demo: any use is a bug in the test. */
export const unusedDemo: DemoShell = {
  databasePath: '/unused/demo.db',
  hasDatabase: () => false,
  prepare: () => Promise.reject(new Error('demo used')),
  serve: () => Promise.resolve(err(demoFailures.of(DemoFailureCode.enum.port_in_use))),
};
