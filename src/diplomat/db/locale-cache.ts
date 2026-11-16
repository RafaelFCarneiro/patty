import { Locale } from '../../models/locale.js';
import type { SettingsRepo } from './repos/settings.js';

export type LocaleResolver = {
  locale: (userId: string, settings: Pick<SettingsRepo, 'getLocale'>) => Promise<Locale>;
  resetLocale: (userId: string) => void;
};

// resetLocale is shell-only — never a Deps field; a diplomat handler calls it after its own
// setLocale write commits. configLocale (PATTY_LOCALE) always wins, for every user, and is never cached.
// Keyed by user, so one person's language never becomes another's. A reset also bumps the user's generation: a lookup
// that started before it (it may have read the old language) must not put its result back in the cache.
export const createLocaleResolver = (configLocale?: Locale): LocaleResolver => {
  const cachedByUser = new Map<string, Locale>();
  const generationByUser = new Map<string, number>();
  const generationOf = (userId: string): number => generationByUser.get(userId) ?? 0;

  return {
    locale: async (userId, settings) => {
      if (configLocale) return configLocale;
      const cached = cachedByUser.get(userId);
      if (cached) return cached;
      const generation = generationOf(userId);
      const row = await settings.getLocale();
      const locale = row?.locale ?? Locale.enum.en;
      if (generationOf(userId) === generation) cachedByUser.set(userId, locale);
      return locale;
    },
    resetLocale: (userId) => {
      generationByUser.set(userId, generationOf(userId) + 1);
      cachedByUser.delete(userId);
    },
  };
};
