import { CurrencyCode } from '../models/money.js';
import { Locale, LocaleSource, type SetLocaleSource } from '../models/locale.js';

export const canAutoSwitchLocale = (
  source: SetLocaleSource,
  current: { localeSource: LocaleSource } | null | undefined,
  wouldChange: boolean,
): boolean =>
  !(source === LocaleSource.enum.inferred && current?.localeSource === LocaleSource.enum.explicit && wouldChange);

export const localeToBaseCurrency = (locale: Locale): CurrencyCode =>
  locale === Locale.enum.pt ? CurrencyCode.enum.BRL : CurrencyCode.enum.USD;

export const resolveBaseCurrency = (stored: CurrencyCode | null | undefined, locale: Locale): CurrencyCode =>
  stored ?? localeToBaseCurrency(locale);
