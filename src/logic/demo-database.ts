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

/** `createdHere`: this run owns the file, so a failed seed may remove it. */
export const planDemoDatabase = ({
  isRealDatabase,
  isAlias,
  reset,
  probe,
  holdsData,
}: DemoDatabaseFacts): Result<DemoDatabasePlan, DemoRefusal> => {
  if (isRealDatabase) return err(DemoFailureCode.enum.real_database);
  if (isAlias || probe === DemoProbeAbsence.enum.unreadable) return err(DemoFailureCode.enum.not_demo);
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
