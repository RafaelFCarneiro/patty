import { z } from 'zod';
import type { ValidationError } from './error.js';

export const Locale = z.enum(['en', 'es', 'pt']);
export type Locale = z.infer<typeof Locale>;

export const LocaleSource = z.enum(['default', 'inferred', 'explicit']);
export type LocaleSource = z.infer<typeof LocaleSource>;

export type LabelMap<E extends string> = Record<E, Record<Locale, string>>;

export type SetLocaleSource = typeof LocaleSource.enum.inferred | typeof LocaleSource.enum.explicit;

export type Preferences = {
  locale: Locale;
  localeSource: LocaleSource;
};

export type SetLocaleInput = {
  locale: Locale;
  source: SetLocaleSource;
};

export type LocaleError = ValidationError;

export const localeErrors = {
  explicitLocaleBlock: {
    code: 'validation',
    issues: ['Cannot auto-switch locale: user set it explicitly. Use source "explicit" to override.'],
  } satisfies LocaleError,
};
