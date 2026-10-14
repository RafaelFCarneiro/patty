import { Locale } from '../../models/locale.js';
import type { SettingsRepo } from './repos/settings.js';

/** What a request's `deps.locale` is: the locale of ONE user, resolved from the shared cache. */
export type LocaleResolver = {
  locale: (userId: string, settings: Pick<SettingsRepo, 'getLocale'>) => Promise<Locale>;
  resetLocale: (userId: string) => void;
};

// resetLocale is shell-only — never a Deps field; a diplomat handler calls it after its own
// setLocale write commits. configLocale (FINTRACK_LOCALE) always wins, for every user, and is never cached.
// The cache is keyed by user (ADR-033 §5): one person's language never becomes another's. It holds only what the
// database holds, so dropping an entry is always safe — the next request reads it again.
export const createLocaleResolver = (configLocale?: Locale): LocaleResolver => {
  const cachedByUser = new Map<string, Locale>();

  return {
    locale: async (userId, settings) => {
      if (configLocale) return configLocale;
      const cached = cachedByUser.get(userId);
      if (cached) return cached;
      const row = await settings.getLocale();
      const locale = row?.locale ?? Locale.enum.en;
      cachedByUser.set(userId, locale);
      return locale;
    },
    resetLocale: (userId) => {
      cachedByUser.delete(userId);
    },
  };
};
