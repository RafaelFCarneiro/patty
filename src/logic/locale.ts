import { CurrencyCode } from '../models/money.js';
import { Locale, LocaleSource, type SetLocaleSource } from '../models/locale.js';

/** Inferred locale changes are blocked when the user set it explicitly and the value differs. */
export const canAutoSwitchLocale = (
  source: SetLocaleSource,
  current: { localeSource: LocaleSource } | null | undefined,
  wouldChange: boolean,
): boolean =>
  !(source === LocaleSource.enum.inferred && current?.localeSource === LocaleSource.enum.explicit && wouldChange);

/** The locale-derived base-currency default (ADR-026 Phase 2, decided): pt→BRL, en/es→USD. */
export const localeToBaseCurrency = (locale: Locale): CurrencyCode =>
  locale === Locale.enum.pt ? CurrencyCode.enum.BRL : CurrencyCode.enum.USD;

/** Resolves the effective base currency the same way locale itself resolves: the stored explicit
 *  value wins; otherwise it's derived from locale. */
export const resolveBaseCurrency = (stored: CurrencyCode | null | undefined, locale: Locale): CurrencyCode =>
  stored ?? localeToBaseCurrency(locale);
