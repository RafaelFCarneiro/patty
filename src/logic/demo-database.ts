import { err, ok, type Result } from 'neverthrow';
import { DemoFailureCode, type DemoProbe } from '../models/demo.js';
import { InstanceKind } from '../models/instance.js';

export type DemoDatabaseFacts = {
  /** The demo path is the real install's `DB_PATH`. */
  isRealDatabase: boolean;
  reset: boolean;
  probe: DemoProbe;
};

export type DemoRefusal = typeof DemoFailureCode.enum.real_database | typeof DemoFailureCode.enum.not_demo;

/**
 * What `demo` may do with the file at the demo path: go on (`deleteFirst` when `--reset` asked to start over and the
 * file is a demo database), or refuse. Only a database that says it is a demo is ever deleted; the real `DB_PATH` and
 * anything that does not open with the demo key are never touched. Whether a demo is complete is the seeder's call.
 */
export const planDemoDatabase = ({
  isRealDatabase,
  reset,
  probe,
}: DemoDatabaseFacts): Result<{ deleteFirst: boolean }, DemoRefusal> => {
  if (isRealDatabase) return err(DemoFailureCode.enum.real_database);
  if (probe === 'unreadable') return err(DemoFailureCode.enum.not_demo);
  if (probe === InstanceKind.enum.standard && reset) return err(DemoFailureCode.enum.not_demo);
  return ok({ deleteFirst: reset && probe === InstanceKind.enum.demo });
};
