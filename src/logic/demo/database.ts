import { err, ok, type Result } from 'neverthrow';
import {
  DemoFailureCode,
  DemoProbeAbsence,
  type DemoDatabaseFacts,
  type DemoDatabasePlan,
  type DemoRefusal,
  type DemoSeedStatus,
} from '../../models/demo/demo.js';
import { InstanceKind } from '../../models/instance.js';

/** `createdHere`: this run owns the file, so a failed seed may remove it. */
/** The refusals that need no look at the file — and must come before anything is created beside it, a lock file
 *  included: the real database, and a symlink. */
export const refusalWithoutProbe = ({
  isRealDatabase,
  isAlias,
}: Pick<DemoDatabaseFacts, 'isRealDatabase' | 'isAlias'>): DemoRefusal | null => {
  if (isRealDatabase) return DemoFailureCode.enum.real_database;
  return isAlias ? DemoFailureCode.enum.not_demo : null;
};

export const planDemoDatabase = (facts: DemoDatabaseFacts): Result<DemoDatabasePlan, DemoRefusal> => {
  const { reset, probe, holdsData } = facts;
  const early = refusalWithoutProbe(facts);
  if (early !== null) return err(early);
  if (probe === DemoProbeAbsence.enum.unreadable) return err(DemoFailureCode.enum.not_demo);
  if (probe === InstanceKind.enum.standard && (reset || holdsData)) return err(DemoFailureCode.enum.not_demo);
  const deleteFirst = reset && probe === InstanceKind.enum.demo;
  return ok({ deleteFirst, createdHere: deleteFirst || probe === DemoProbeAbsence.enum.missing });
};

const FAILURE_OF_STATUS: Readonly<Record<DemoSeedStatus, DemoFailureCode | null>> = {
  seeded: null,
  present: null,
  interrupted: DemoFailureCode.enum.interrupted,
  not_demo: DemoFailureCode.enum.not_demo,
};

export const failureOfSeedStatus = (status: DemoSeedStatus): DemoFailureCode | null => FAILURE_OF_STATUS[status];
