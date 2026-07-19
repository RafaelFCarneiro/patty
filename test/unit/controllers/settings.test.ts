import { describe, expect, it } from 'vitest';
import { Locale, LocaleSource, SETTINGS_ENTITY_TAG, SETTINGS_SINGLETON_ID } from '../../../src/models/locale.js';
import { PersistOp } from '../../../src/models/persistable.js';
import { getPreferences, setLocale } from '../../../src/controllers/settings.js';
import type { Deps } from '../../../src/controllers/deps.js';
import type { SettingsEntity } from '../../../src/models/locale.js';

const makeDeps = (stored?: SettingsEntity, envLocale?: Locale): Deps => ({
  settings: {
    getLocale: async () => stored,
  },
  locale: async () => envLocale ?? stored?.locale ?? Locale.enum.en,
  accounts: {} as Deps['accounts'],
  bills: {} as Deps['bills'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  creditCards: {} as Deps['creditCards'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: {} as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  tags: {} as Deps['tags'],
  transactions: {} as Deps['transactions'],
  clock: () => new Date(),
  newId: () => 'test-id',
});

const storedRow = (locale: Locale, localeSource: LocaleSource, version = 0): SettingsEntity => ({
  id: SETTINGS_SINGLETON_ID,
  locale,
  localeSource,
  version,
});

describe('getPreferences', () => {
  it('returns stored locale and source from DB', async () => {
    const deps = makeDeps(storedRow(Locale.enum.pt, LocaleSource.enum.explicit), Locale.enum.en);
    const prefs = await getPreferences(deps);
    expect(prefs).toEqual({ locale: Locale.enum.pt, localeSource: LocaleSource.enum.explicit });
  });

  it('returns DB values even when env locale differs', async () => {
    const deps = makeDeps(storedRow(Locale.enum.pt, LocaleSource.enum.inferred), Locale.enum.en);
    const prefs = await getPreferences(deps);
    expect(prefs.locale).toBe(Locale.enum.pt);
  });

  it('defaults to en/default when no settings row exists', async () => {
    const deps = makeDeps(undefined);
    const prefs = await getPreferences(deps);
    expect(prefs).toEqual({ locale: Locale.enum.en, localeSource: LocaleSource.enum.default });
  });
});

describe('setLocale', () => {
  it('emits an insert and returns the written locale when no settings row exists yet', async () => {
    const deps = makeDeps(undefined, Locale.enum.en);
    const result = await setLocale(deps, { locale: Locale.enum.pt, source: LocaleSource.enum.explicit });
    const outcome = result._unsafeUnwrap();
    expect(outcome.response).toEqual({ locale: Locale.enum.pt, localeSource: LocaleSource.enum.explicit });
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.insert,
        entity: SETTINGS_ENTITY_TAG,
        model: { id: SETTINGS_SINGLETON_ID, locale: Locale.enum.pt, localeSource: LocaleSource.enum.explicit },
      },
    ]);
  });

  it('emits a version-guarded update when a settings row already exists', async () => {
    const deps = makeDeps(storedRow(Locale.enum.pt, LocaleSource.enum.explicit, 3));
    const result = await setLocale(deps, { locale: Locale.enum.en, source: LocaleSource.enum.explicit });
    const outcome = result._unsafeUnwrap();
    expect(outcome.response).toEqual({ locale: Locale.enum.en, localeSource: LocaleSource.enum.explicit });
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: SETTINGS_ENTITY_TAG,
        model: {
          id: SETTINGS_SINGLETON_ID,
          locale: Locale.enum.en,
          localeSource: LocaleSource.enum.explicit,
          version: 3,
        },
      },
    ]);
  });

  it('rejects inferred switch when current source is explicit', async () => {
    const deps = makeDeps(storedRow(Locale.enum.pt, LocaleSource.enum.explicit));
    const result = await setLocale(deps, { locale: Locale.enum.en, source: LocaleSource.enum.inferred });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'validation' });
  });

  it('allows explicit switch when current source is explicit', async () => {
    const deps = makeDeps(storedRow(Locale.enum.pt, LocaleSource.enum.explicit));
    const result = await setLocale(deps, { locale: Locale.enum.en, source: LocaleSource.enum.explicit });
    expect(result.isOk()).toBe(true);
  });

  it('inferred no-op preserves explicit source and emits no writes', async () => {
    const deps = makeDeps(storedRow(Locale.enum.pt, LocaleSource.enum.explicit));
    const result = await setLocale(deps, { locale: Locale.enum.pt, source: LocaleSource.enum.inferred });
    const outcome = result._unsafeUnwrap();
    expect(outcome.response).toEqual({ locale: Locale.enum.pt, localeSource: LocaleSource.enum.explicit });
    expect(outcome.persist).toEqual([]);
  });
});
