import { z } from 'zod';
import { CurrencyCode } from './money.js';
import { withPersistenceMeta } from '../effects/persistable.js';
import type { ValidationError } from './error.js';

export const Locale = z.enum(['en', 'es', 'pt']);
export type Locale = z.infer<typeof Locale>;

export const LocaleSource = z.enum(['default', 'inferred', 'explicit']);
export type LocaleSource = z.infer<typeof LocaleSource>;

export const SETTINGS_ENTITY_TAG = 'settings';
export const SETTINGS_SINGLETON_ID = 'singleton';

export const SettingsEntitySchema = withPersistenceMeta(
  z.object({
    id: z.literal(SETTINGS_SINGLETON_ID),
    locale: Locale,
    localeSource: LocaleSource,
    // Explicit override; null means "derive from locale" (logic/locale.ts's resolveBaseCurrency,
    // ADR-026 Phase 2) — unlike locale/localeSource, there is no separate explicit/inferred source
    // to track, so a plain nullable column is enough.
    baseCurrency: CurrencyCode.nullable(),
  }),
);
export type SettingsEntity = z.infer<typeof SettingsEntitySchema>;

export type LabelMap<E extends string> = Record<E, Record<Locale, string>>;

export type SetLocaleSource = typeof LocaleSource.enum.inferred | typeof LocaleSource.enum.explicit;

export const PreferencesSchema = z.object({
  locale: Locale,
  localeSource: LocaleSource,
  baseCurrency: CurrencyCode.describe('Resolved base currency — the explicit override, or the locale-derived default'),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

export type SetLocaleInput = {
  locale: Locale;
  source: SetLocaleSource;
};

export type SetBaseCurrencyInput = {
  baseCurrency: CurrencyCode;
};

/** `setLocale`'s own response shape — only the fields it actually changes, so it never has to
 *  fabricate a `baseCurrency` it didn't touch (`getPreferences` returns the full `Preferences`). */
export type LocalePreferences = Pick<Preferences, 'locale' | 'localeSource'>;

/** `setBaseCurrency`'s own response shape, mirroring `LocalePreferences`. */
export type BaseCurrencyPreferences = Pick<Preferences, 'baseCurrency'>;

export type LocaleError = ValidationError;

export const localeErrors = {
  explicitLocaleBlock: {
    code: 'validation',
    issues: ['Cannot auto-switch locale: user set it explicitly. Use source "explicit" to override.'],
  } satisfies LocaleError,
};
