import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import { Locale, LocaleSource } from '../models/locale.js'
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

export const setLocale = (deps: Deps, input: SetLocaleInput): ResultAsync<Preferences, AppError> =>
  safeTry(async function* () {
    const current = await deps.settings.getLocale()
    const wouldChange = current?.locale !== input.locale
    yield* guard(
      !(input.source === LocaleSource.enum.inferred &&
        current?.localeSource === LocaleSource.enum.explicit &&
        wouldChange),
      { code: 'validation', issues: ['Cannot auto-switch locale: user set it explicitly. Use source "explicit" to override.'] },
    )
    if (!wouldChange && current) {
      return ok({ locale: current.locale, localeSource: current.localeSource })
    }
    await deps.settings.setLocale(input.locale, input.source)
    deps.invalidateLocale()
    return ok({ locale: input.locale, localeSource: input.source })
  })
