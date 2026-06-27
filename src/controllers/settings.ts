import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import { canAutoSwitchLocale } from '../logic/locale.js'
import { Locale, localeErrors, LocaleSource } from '../models/locale.js'
import type { Preferences, SetLocaleInput } from '../models/locale.js'
import type { Deps } from './deps.js'

export const getPreferences = async (deps: Deps): Promise<Preferences> => {
  const row = await deps.settings.getLocale()
  return {
    locale: row?.locale ?? Locale.enum.en,
    localeSource: row?.localeSource ?? LocaleSource.enum.default,
  }
}

export const setLocale = (deps: Deps, input: SetLocaleInput): ResultAsync<Preferences, AppError> =>
  safeTry(async function* () {
    const current = await deps.settings.getLocale()
    const wouldChange = current?.locale !== input.locale
    yield* guard(
      canAutoSwitchLocale(input.source, current, wouldChange),
      localeErrors.explicitLocaleBlock,
    )
    if (!wouldChange && current) {
      return ok({ locale: current.locale, localeSource: current.localeSource })
    }
    await deps.settings.setLocale(input.locale, input.source)
    deps.resetLocale()
    return ok({ locale: input.locale, localeSource: input.source })
  })
