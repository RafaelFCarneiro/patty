import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import type { ValidationError } from '../models/error.js'
import { Locale, LocaleSource } from '../models/locale.js'

const settingsErrors = {
  explicitLocaleBlock: {
    code: 'validation',
    issues: ['Cannot auto-switch locale: user set it explicitly. Use source "explicit" to override.'],
  } satisfies ValidationError,
}
import type { Deps } from './deps.js'

export type Preferences = {
  locale: Locale
  localeSource: LocaleSource
}

export const getPreferences = async (deps: Deps): Promise<Preferences> => {
  const row = await deps.settings.getLocale()
  return {
    locale: row?.locale ?? Locale.enum.en,
    localeSource: row?.localeSource ?? LocaleSource.enum.default,
  }
}

export type SetLocaleSource = typeof LocaleSource.enum.inferred | typeof LocaleSource.enum.explicit

export type SetLocaleInput = {
  locale: Locale
  source: SetLocaleSource
}

/** Inferred locale changes are blocked when the user set it explicitly and the value differs. */
const canAutoSwitchLocale = (
  source: SetLocaleSource,
  current: { localeSource: LocaleSource } | null | undefined,
  wouldChange: boolean,
): boolean =>
  !(source === LocaleSource.enum.inferred &&
    current?.localeSource === LocaleSource.enum.explicit &&
    wouldChange)

export const setLocale = (deps: Deps, input: SetLocaleInput): ResultAsync<Preferences, AppError> =>
  safeTry(async function* () {
    const current = await deps.settings.getLocale()
    const wouldChange = current?.locale !== input.locale
    yield* guard(
      canAutoSwitchLocale(input.source, current, wouldChange),
      settingsErrors.explicitLocaleBlock,
    )
    if (!wouldChange && current) {
      return ok({ locale: current.locale, localeSource: current.localeSource })
    }
    await deps.settings.setLocale(input.locale, input.source)
    deps.resetLocale()
    return ok({ locale: input.locale, localeSource: input.source })
  })
