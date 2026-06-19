import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import type { Locale, LocaleSource } from '../models/locale.js'
import { LocaleSource as LocaleSourceEnum } from '../models/locale.js'
import type { Deps } from './deps.js'

export type Preferences = {
  locale: Locale
  localeSource: LocaleSource
}

export const getPreferences = async (deps: Deps): Promise<Preferences> => {
  const locale = await deps.locale()
  const row = await deps.settings.getLocale()
  return { locale, localeSource: row?.localeSource ?? LocaleSourceEnum.enum.default }
}

export type SetLocaleInput = {
  locale: Locale
  source: LocaleSource
}

export const setLocale = (deps: Deps, input: SetLocaleInput): ResultAsync<Preferences, AppError> =>
  safeTry(async function* () {
    const current = await deps.settings.getLocale()
    yield* guard(
      !(input.source === LocaleSourceEnum.enum.inferred &&
        current?.localeSource === LocaleSourceEnum.enum.explicit),
      { code: 'validation', issues: ['Cannot auto-switch locale: user set it explicitly. Use source "explicit" to override.'] },
    )
    await deps.settings.setLocale(input.locale, input.source)
    const locale = await deps.locale()
    return ok({ locale, localeSource: input.source })
  })
