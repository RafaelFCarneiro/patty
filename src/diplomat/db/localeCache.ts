import { Locale } from '../../models/locale.js';
import type { SettingsRepo } from './repos/settings.js';

/** The shell's process-level locale cache: `locale()` is what `Deps.locale` becomes — read
 *  dependencies only, never a write (docs/functional-core-imperative-shell.md rule 2).
 *  `resetLocale` is shell-only bookkeeping, not part of `Deps` — only a diplomat handler that just
 *  applied a `setLocale` write calls it, after the write commits. */
export type LocaleResolver = {
  locale: () => Promise<Locale>;
  resetLocale: () => void;
};

/**
 * Builds the cached locale resolver `main.ts` (and the integration test harness) wires into
 * `Deps.locale` / the shell's `resetLocale` call. `configLocale` (`FINTRACK_LOCALE`) always wins
 * and is never cached from the DB; otherwise the first read of `settings.getLocale()` is cached
 * until `resetLocale` clears it.
 */
export const createLocaleResolver = (
  settings: Pick<SettingsRepo, 'getLocale'>,
  configLocale?: Locale,
): LocaleResolver => {
  let cachedLocale: Locale | null = null;

  return {
    locale: async () => {
      if (configLocale) return configLocale;
      if (cachedLocale) return cachedLocale;
      const row = await settings.getLocale();
      cachedLocale = row?.locale ?? Locale.enum.en;
      return cachedLocale;
    },
    resetLocale: () => {
      cachedLocale = null;
    },
  };
};
