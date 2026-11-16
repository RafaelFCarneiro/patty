import { describe, expect, it, vi } from 'vitest';
import { createLocaleResolver } from '../../../../src/diplomat/db/locale-cache.js';
import { Locale, LocaleSource, type UserSettingsEntity } from '../../../../src/models/locale.js';
import type { SettingsRepo } from '../../../../src/diplomat/db/repos/settings.js';

const makeSettings = (locale?: Locale): SettingsRepo => ({
  getLocale: vi.fn(async (): Promise<UserSettingsEntity | undefined> =>
    locale ? { locale, localeSource: LocaleSource.enum.explicit, baseCurrency: null, version: 0 } : undefined,
  ),
});

const USER = 'user-a';
const OTHER_USER = 'user-b';

describe('createLocaleResolver', () => {
  it('caches the DB read across repeated locale() calls', async () => {
    const settings = makeSettings(Locale.enum.pt);
    const { locale } = createLocaleResolver();

    expect(await locale(USER, settings)).toBe(Locale.enum.pt);
    expect(await locale(USER, settings)).toBe(Locale.enum.pt);
    expect(settings.getLocale).toHaveBeenCalledOnce();
  });

  it('defaults to en when no settings row exists', async () => {
    const { locale } = createLocaleResolver();

    expect(await locale(USER, makeSettings())).toBe(Locale.enum.en);
  });

  it('resetLocale clears the cache, so the next locale() call re-reads the DB', async () => {
    const settings = makeSettings(Locale.enum.pt);
    const { locale, resetLocale } = createLocaleResolver();

    expect(await locale(USER, settings)).toBe(Locale.enum.pt);
    resetLocale(USER);
    expect(await locale(USER, settings)).toBe(Locale.enum.pt);
    expect(settings.getLocale).toHaveBeenCalledTimes(2);
  });

  it('a lookup that started before a reset does not put its stale result back in the cache', async () => {
    let finishRead: (entity: UserSettingsEntity) => void = () => undefined;
    const slowRead = new Promise<UserSettingsEntity>((resolve) => (finishRead = resolve));
    const staleSettings: SettingsRepo = { getLocale: vi.fn(() => slowRead) };
    const freshSettings = makeSettings(Locale.enum.pt);
    const { locale, resetLocale } = createLocaleResolver();

    const inFlight = locale(USER, staleSettings);
    resetLocale(USER);
    finishRead({ locale: Locale.enum.en, localeSource: LocaleSource.enum.default, baseCurrency: null, version: 0 });
    await inFlight;

    expect(await locale(USER, freshSettings)).toBe(Locale.enum.pt);
    expect(freshSettings.getLocale).toHaveBeenCalledOnce();
  });

  it('a reset for one user never keeps another user’s lookup from caching', async () => {
    const settings = makeSettings(Locale.enum.es);
    const { locale, resetLocale } = createLocaleResolver();

    const inFlight = locale(OTHER_USER, settings);
    resetLocale(USER);
    await inFlight;
    await locale(OTHER_USER, settings);

    expect(settings.getLocale).toHaveBeenCalledOnce();
  });

  it('a configLocale override always wins, for every user, and never touches the DB', async () => {
    const settings = makeSettings(Locale.enum.pt);
    const { locale } = createLocaleResolver(Locale.enum.es);

    expect(await locale(USER, settings)).toBe(Locale.enum.es);
    expect(await locale(OTHER_USER, settings)).toBe(Locale.enum.es);
    expect(settings.getLocale).not.toHaveBeenCalled();
  });

  it('keeps one cache entry per user: one person’s language never becomes another’s', async () => {
    const portuguese = makeSettings(Locale.enum.pt);
    const spanish = makeSettings(Locale.enum.es);
    const { locale } = createLocaleResolver();

    expect(await locale(USER, portuguese)).toBe(Locale.enum.pt);
    expect(await locale(OTHER_USER, spanish)).toBe(Locale.enum.es);
    expect(await locale(USER, portuguese)).toBe(Locale.enum.pt);
    expect(portuguese.getLocale).toHaveBeenCalledOnce();
    expect(spanish.getLocale).toHaveBeenCalledOnce();
  });

  it('resetLocale drops only that user’s entry', async () => {
    const portuguese = makeSettings(Locale.enum.pt);
    const spanish = makeSettings(Locale.enum.es);
    const { locale, resetLocale } = createLocaleResolver();
    await locale(USER, portuguese);
    await locale(OTHER_USER, spanish);

    resetLocale(USER);
    await locale(USER, portuguese);
    await locale(OTHER_USER, spanish);

    expect(portuguese.getLocale).toHaveBeenCalledTimes(2);
    expect(spanish.getLocale).toHaveBeenCalledOnce();
  });
});
