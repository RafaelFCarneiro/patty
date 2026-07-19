import { z } from 'zod';
import type { ValidationError } from './error.js';

export const Locale = z.enum(['en', 'es', 'pt']);
export type Locale = z.infer<typeof Locale>;

export const LocaleSource = z.enum(['default', 'inferred', 'explicit']);
export type LocaleSource = z.infer<typeof LocaleSource>;

// The settings aggregate owns its own entity tag (docs/functional-core-imperative-shell.md),
// mirroring `models/account.ts`'s `ACCOUNT_ENTITY_TAG`. `settings` is a singleton table — every
// row's `id` is this one constant, never a per-request `crypto.randomUUID()`.
export const SETTINGS_ENTITY_TAG = 'settings';
export const SETTINGS_SINGLETON_ID = 'singleton';

// The persistence-side entity: the stored preference row plus the optimistic-concurrency
// `version` token. Never sent over the wire — only `setLocale`'s read-decide step and
// `diplomat/db/repos/settings.ts`'s `settingsApplier` speak this shape.
export const SettingsEntitySchema = z.object({
  id: z.literal(SETTINGS_SINGLETON_ID),
  locale: Locale,
  localeSource: LocaleSource,
  version: z.number().int().nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out'),
});
export type SettingsEntity = z.infer<typeof SettingsEntitySchema>;

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
