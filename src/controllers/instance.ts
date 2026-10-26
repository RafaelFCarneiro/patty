import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { FlowOutcome } from '@rfc0/effect-runner';
import type { AppError } from '../common/errors.js';
import * as persistence from '../logic/persistence.js';
import { INSTANCE_SETTINGS_ENTITY_TAG } from '../models/auth/entity.js';
import { DEFAULT_INSTANCE, InstanceKind, isDemoInstance, type InstanceFacts } from '../models/instance.js';
import type { AuthDeps, Tenancy } from './deps.js';

/** The marker, and — only for a demo — the language it speaks. A standard database never reads the locale. */
export const instanceFactsOf = async (
  tenancy: Pick<Tenancy, 'instanceKind' | 'instanceLocale'>,
): Promise<InstanceFacts> => {
  const kind = await tenancy.instanceKind();
  return isDemoInstance(kind) ? { kind, locale: await tenancy.instanceLocale() } : { ...DEFAULT_INSTANCE, kind };
};

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

/** Writes the completion marker, the demo seeder's last step: a demo that has it was seeded in full, one that does not
 *  was interrupted. Recording it again keeps the first time. */
export const completeDemoSeed = (
  deps: Pick<AuthDeps, 'instanceSettings'>,
  seededAt: string,
): ResultAsync<FlowOutcome<string>, AppError> =>
  safeTry(async function* () {
    const current = await deps.instanceSettings.get();
    if (current.demoSeededAt !== null) return ok({ persist: [], response: current.demoSeededAt });
    const write = persistence.update({
      entity: INSTANCE_SETTINGS_ENTITY_TAG,
      model: { ...current, demoSeededAt: seededAt },
    });
    return ok({ persist: [write], response: seededAt });
  });
