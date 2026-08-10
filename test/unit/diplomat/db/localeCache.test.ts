import { describe, expect, it, vi } from 'vitest';
import { createLocaleResolver } from '../../../../src/diplomat/db/localeCache.js';
import { Locale, LocaleSource, SETTINGS_SINGLETON_ID, type SettingsEntity } from '../../../../src/models/locale.js';
import type { SettingsRepo } from '../../../../src/diplomat/db/repos/settings.js';

const makeSettings = (locale?: Locale): SettingsRepo => ({
  getLocale: vi.fn(async (): Promise<SettingsEntity | undefined> =>
    locale
      ? { id: SETTINGS_SINGLETON_ID, locale, localeSource: LocaleSource.enum.explicit, baseCurrency: null, version: 0 }
      : undefined,
  ),
});

describe('createLocaleResolver', () => {
  it('caches the DB read across repeated locale() calls', async () => {
    const settings = makeSettings(Locale.enum.pt);
    const { locale } = createLocaleResolver(settings);

    expect(await locale()).toBe(Locale.enum.pt);
    expect(await locale()).toBe(Locale.enum.pt);
    expect(settings.getLocale).toHaveBeenCalledOnce();
  });

  it('defaults to en when no settings row exists', async () => {
    const settings = makeSettings();
    const { locale } = createLocaleResolver(settings);

    expect(await locale()).toBe(Locale.enum.en);
  });

  it('resetLocale clears the cache, so the next locale() call re-reads the DB', async () => {
    const settings = makeSettings(Locale.enum.pt);
    const { locale, resetLocale } = createLocaleResolver(settings);

    expect(await locale()).toBe(Locale.enum.pt);
    resetLocale();
    expect(await locale()).toBe(Locale.enum.pt);
    expect(settings.getLocale).toHaveBeenCalledTimes(2);
  });

  it('a configLocale override always wins and never touches the DB', async () => {
    const settings = makeSettings(Locale.enum.pt);
    const { locale } = createLocaleResolver(settings, Locale.enum.es);

    expect(await locale()).toBe(Locale.enum.es);
    expect(settings.getLocale).not.toHaveBeenCalled();
  });
});
