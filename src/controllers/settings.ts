import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard } from '../common/result.js';
import { canAutoSwitchLocale } from '../logic/locale.js';
import * as persistence from '../logic/persistence.js';
import {
  Locale,
  localeErrors,
  LocaleSource,
  SETTINGS_ENTITY_TAG,
  SETTINGS_SINGLETON_ID,
  type Preferences,
  type SetLocaleInput,
  type SettingsEntity,
} from '../models/locale.js';
import type { FlowOutcome, Persistable } from '../models/persistable.js';
import type { Deps } from './deps.js';

export const getPreferences = async (deps: Deps): Promise<Preferences> => {
  const row = await deps.settings.getLocale();
  return {
    locale: row?.locale ?? Locale.enum.en,
    localeSource: row?.localeSource ?? LocaleSource.enum.default,
  };
};

// The locale cache reset (main.ts's process-level cache) is shell bookkeeping, not a domain
// effect — the shell resets it after this flow's write commits, never from here.
export const setLocale = (deps: Deps, input: SetLocaleInput): ResultAsync<FlowOutcome<Preferences>, AppError> =>
  safeTry(async function* () {
    const current = await deps.settings.getLocale();
    const wouldChange = current?.locale !== input.locale;
    yield* guard(canAutoSwitchLocale(input.source, current, wouldChange), localeErrors.explicitLocaleBlock);

    if (!wouldChange && current) {
      const response = { locale: current.locale, localeSource: current.localeSource };
      return ok({ persist: [], response });
    }

    const entity: Omit<SettingsEntity, 'version'> = {
      id: SETTINGS_SINGLETON_ID,
      locale: input.locale,
      localeSource: input.source,
    };
    const persist: Persistable[] = current
      ? [persistence.update({ entity: SETTINGS_ENTITY_TAG, model: { ...entity, version: current.version } })]
      : [persistence.insert({ entity: SETTINGS_ENTITY_TAG, model: entity })];

    return ok({ persist, response: { locale: input.locale, localeSource: input.source } });
  });
