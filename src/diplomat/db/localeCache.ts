import { Locale } from '../../models/locale.js';
import type { SettingsRepo } from './repos/settings.js';

export type LocaleResolver = {
  locale: () => Promise<Locale>;
  resetLocale: () => void;
};

// resetLocale is shell-only — never a Deps field; a diplomat handler calls it after its own
// setLocale write commits. configLocale (FINTRACK_LOCALE) always wins and is never cached.
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
