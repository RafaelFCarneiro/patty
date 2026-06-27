import { LocaleSource, type SetLocaleSource } from '../models/locale.js'

/** Inferred locale changes are blocked when the user set it explicitly and the value differs. */
export const canAutoSwitchLocale = (
  source: SetLocaleSource,
  current: { localeSource: LocaleSource } | null | undefined,
  wouldChange: boolean,
): boolean =>
  !(source === LocaleSource.enum.inferred &&
    current?.localeSource === LocaleSource.enum.explicit &&
    wouldChange)
