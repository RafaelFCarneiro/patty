import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard } from '../common/result.js';
import { canAutoSwitchLocale, resolveBaseCurrency } from '../logic/locale.js';
import * as persistence from '../logic/persistence.js';
import {
  Locale,
  localeErrors,
  LocaleSource,
  USER_SETTINGS_ENTITY_TAG,
  type BaseCurrencyPreferences,
  type LocalePreferences,
  type Preferences,
  type SetBaseCurrencyInput,
  type SetLocaleInput,
  type UserSettingsEntity,
} from '../models/locale.js';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import type { Deps } from './deps.js';

export const getPreferences = async (deps: Deps): Promise<Preferences> => {
  const row = await deps.settings.getLocale();
  const locale = row?.locale ?? Locale.enum.en;
  return {
    locale,
    localeSource: row?.localeSource ?? LocaleSource.enum.default,
    baseCurrency: resolveBaseCurrency(row?.baseCurrency, locale),
  };
};

export const setLocale = (deps: Deps, input: SetLocaleInput): ResultAsync<FlowOutcome<LocalePreferences>, AppError> =>
  safeTry(async function* () {
    const current = await deps.settings.getLocale();
    const wouldChange = current?.locale !== input.locale;
    yield* guard(canAutoSwitchLocale(input.source, current, wouldChange), localeErrors.explicitLocaleBlock);

    if (!wouldChange && current) {
      const response = { locale: current.locale, localeSource: current.localeSource };
      return ok({ persist: [], response });
    }

    const entity: Omit<UserSettingsEntity, 'version'> = {
      locale: input.locale,
      localeSource: input.source,
      baseCurrency: current?.baseCurrency ?? null,
    };
    const persist: Persistable[] = current
      ? [persistence.update({ entity: USER_SETTINGS_ENTITY_TAG, model: { ...entity, version: current.version } })]
      : [persistence.insert({ entity: USER_SETTINGS_ENTITY_TAG, model: entity })];

    return ok({ persist, response: { locale: input.locale, localeSource: input.source } });
  });

export const setBaseCurrency = (
  deps: Deps,
  input: SetBaseCurrencyInput,
): ResultAsync<FlowOutcome<BaseCurrencyPreferences>, AppError> =>
  safeTry(async function* () {
    const current = await deps.settings.getLocale();
    if (current?.baseCurrency === input.baseCurrency) {
      return ok({ persist: [], response: { baseCurrency: input.baseCurrency } });
    }

    const entity: Omit<UserSettingsEntity, 'version'> = {
      locale: current?.locale ?? Locale.enum.en,
      localeSource: current?.localeSource ?? LocaleSource.enum.default,
      baseCurrency: input.baseCurrency,
    };
    const persist: Persistable[] = current
      ? [persistence.update({ entity: USER_SETTINGS_ENTITY_TAG, model: { ...entity, version: current.version } })]
      : [persistence.insert({ entity: USER_SETTINGS_ENTITY_TAG, model: entity })];

    return ok({ persist, response: { baseCurrency: input.baseCurrency } });
  });
