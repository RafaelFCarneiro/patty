import { DEFAULT_INSTANCE, isDemoInstance, type InstanceFacts } from '../models/instance.js';
import type { Tenancy } from './deps.js';

/** The marker, and — only for a demo — the language it speaks. A standard database never reads the locale. */
export const instanceFactsOf = async (
  tenancy: Pick<Tenancy, 'instanceKind' | 'instanceLocale'>,
): Promise<InstanceFacts> => {
  const kind = await tenancy.instanceKind();
  return isDemoInstance(kind) ? { kind, locale: await tenancy.instanceLocale() } : { ...DEFAULT_INSTANCE, kind };
};
