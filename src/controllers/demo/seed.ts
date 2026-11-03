import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { FlowOutcome } from '@rfc0/effect-runner';
import type { AppError } from '../../common/errors.js';
import { demoSeedStart } from '../../logic/demo/plan.js';
import * as persistence from '../../logic/persistence.js';
import { INSTANCE_SETTINGS_ENTITY_TAG } from '../../models/auth/entity.js';
import { InstanceKind, isDemoInstance } from '../../models/instance.js';
import type { DEMO_SEED_FRESH, DemoCountry, DemoSeedStatus } from '../../models/demo/core.js';
import type { AuthDeps, Deps } from '../deps.js';

/** Writes the marker: only the demo seeder calls this. Marking a database that already says `demo` writes nothing. */
export const markDemoInstance = (
  deps: Pick<AuthDeps, 'instanceSettings'>,
): ResultAsync<FlowOutcome<InstanceKind>, AppError> =>
  safeTry(async function* () {
    const current = await deps.instanceSettings.get();
    if (isDemoInstance(current.instanceKind)) return ok({ persist: [], response: current.instanceKind });
    const write = persistence.update({
      entity: INSTANCE_SETTINGS_ENTITY_TAG,
      model: { ...current, instanceKind: InstanceKind.enum.demo },
    });
    return ok({ persist: [write], response: InstanceKind.enum.demo });
  });

export const completeDemoSeed = (
  deps: Pick<AuthDeps, 'instanceSettings'>,
  seededAt: string,
  country: DemoCountry,
): ResultAsync<FlowOutcome<string>, AppError> =>
  safeTry(async function* () {
    const current = await deps.instanceSettings.get();
    if (current.demoSeededAt !== null) return ok({ persist: [], response: current.demoSeededAt });
    const write = persistence.update({
      entity: INSTANCE_SETTINGS_ENTITY_TAG,
      model: { ...current, demoSeededAt: seededAt, demoCountry: country },
    });
    return ok({ persist: [write], response: seededAt });
  });

export const demoSeedStatus = async (
  deps: Pick<Deps, 'instance'> & Pick<AuthDeps, 'instanceSettings'>,
): Promise<DemoSeedStatus | typeof DEMO_SEED_FRESH> =>
  demoSeedStart({
    hasUserData: await deps.instance.hasUserData(),
    kind: await deps.instance.kind(),
    seededAt: (await deps.instanceSettings.get()).demoSeededAt,
  });
