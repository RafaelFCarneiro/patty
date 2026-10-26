import { err, ok, type Result } from 'neverthrow';
import {
  DemoFailureCode,
  DemoProbeAbsence,
  type DemoDatabaseFacts,
  type DemoDatabasePlan,
  type DemoRefusal,
  type DemoSeedStatus,
} from '../models/demo.js';
import { InstanceKind } from '../models/instance.js';

/**
 * What `demo` may do with the file at the demo path: go on (`deleteFirst` when `--reset` asked to start over and the
 * file is a demo database), or refuse. Only a database that says it is a demo is ever deleted; the real `DB_PATH` and
 * anything that does not open with the demo key are never touched. `createdHere` says this run owns the file once it is
 * seeded — it was missing, or is about to be deleted — which is what lets a failed seed remove it. Whether a demo is
 * complete is the seeder's call.
 */
export const planDemoDatabase = ({
  isRealDatabase,
  reset,
  probe,
}: DemoDatabaseFacts): Result<DemoDatabasePlan, DemoRefusal> => {
  if (isRealDatabase) return err(DemoFailureCode.enum.real_database);
  if (probe === DemoProbeAbsence.enum.unreadable) return err(DemoFailureCode.enum.not_demo);
  if (probe === InstanceKind.enum.standard && reset) return err(DemoFailureCode.enum.not_demo);
  const deleteFirst = reset && probe === InstanceKind.enum.demo;
  return ok({ deleteFirst, createdHere: deleteFirst || probe === DemoProbeAbsence.enum.missing });
};

const FAILURE_OF_STATUS: Readonly<Record<DemoSeedStatus, DemoFailureCode | null>> = {
  seeded: null,
  present: null,
  interrupted: DemoFailureCode.enum.interrupted,
  not_demo: DemoFailureCode.enum.not_demo,
};

/** The failure a seed run ending in `status` is reported as; null for a ready demo. */
export const failureOfSeedStatus = (status: DemoSeedStatus): DemoFailureCode | null => FAILURE_OF_STATUS[status];
