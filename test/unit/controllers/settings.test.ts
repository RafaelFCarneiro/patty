import { describe, expect, it } from 'vitest';
import { Locale, LocaleSource, SETTINGS_ENTITY_TAG, SETTINGS_SINGLETON_ID } from '../../../src/models/locale.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { PersistOp } from '@rfc0/effect-runner';
import { getPreferences, setBaseCurrency, setLocale } from '../../../src/controllers/settings.js';
import type { Deps } from '../../../src/controllers/deps.js';
import type { SettingsEntity } from '../../../src/models/locale.js';

const makeDeps = (stored?: SettingsEntity, envLocale?: Locale): Deps => ({
  settings: {
    getLocale: async () => stored,
  },
  locale: async () => envLocale ?? stored?.locale ?? Locale.enum.en,
  rateStaleness: { fiatHours: 24, cryptoHours: 1 },
  accounts: {} as Deps['accounts'],
  bills: {} as Deps['bills'],
  budgets: {} as Deps['budgets'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  correlations: {} as Deps['correlations'],
  creditCards: {} as Deps['creditCards'],
  currencies: {} as Deps['currencies'],
  currencyRates: {} as Deps['currencyRates'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: {} as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  tags: {} as Deps['tags'],
  transactions: {} as Deps['transactions'],
  clock: () => new Date(),
  newId: () => 'test-id',
});

const storedRow = (
  locale: Locale,
  localeSource: LocaleSource,
  version = 0,
  baseCurrency: SettingsEntity['baseCurrency'] = null,
): SettingsEntity => ({
  id: SETTINGS_SINGLETON_ID,
  locale,
  localeSource,
  baseCurrency,
  version,
});

describe('getPreferences', () => {
  it('returns stored locale and source from DB', async () => {
    const deps = makeDeps(storedRow(Locale.enum.pt, LocaleSource.enum.explicit), Locale.enum.en);
    const prefs = await getPreferences(deps);
    expect(prefs).toEqual({
      locale: Locale.enum.pt,
      localeSource: LocaleSource.enum.explicit,
      baseCurrency: CurrencyCode.enum.BRL,
    });
  });

  it('returns DB values even when env locale differs', async () => {
    const deps = makeDeps(storedRow(Locale.enum.pt, LocaleSource.enum.inferred), Locale.enum.en);
    const prefs = await getPreferences(deps);
    expect(prefs.locale).toBe(Locale.enum.pt);
  });

  it('defaults to en/default when no settings row exists', async () => {
    const deps = makeDeps(undefined);
    const prefs = await getPreferences(deps);
    expect(prefs).toEqual({
      locale: Locale.enum.en,
      localeSource: LocaleSource.enum.default,
      baseCurrency: CurrencyCode.enum.USD,
    });
  });

  it('derives base currency from locale when no explicit override is stored (pt -> BRL)', async () => {
    const deps = makeDeps(storedRow(Locale.enum.pt, LocaleSource.enum.explicit, 0, null));
    const prefs = await getPreferences(deps);
    expect(prefs.baseCurrency).toBe(CurrencyCode.enum.BRL);
  });

  it('derives base currency from locale when no explicit override is stored (en -> USD)', async () => {
    const deps = makeDeps(storedRow(Locale.enum.en, LocaleSource.enum.explicit, 0, null));
    const prefs = await getPreferences(deps);
    expect(prefs.baseCurrency).toBe(CurrencyCode.enum.USD);
  });

  it('prefers the stored explicit base currency over the locale-derived default', async () => {
    const deps = makeDeps(storedRow(Locale.enum.pt, LocaleSource.enum.explicit, 0, CurrencyCode.enum.USDC));
    const prefs = await getPreferences(deps);
    expect(prefs.baseCurrency).toBe(CurrencyCode.enum.USDC);
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
        model: {
          id: SETTINGS_SINGLETON_ID,
          locale: Locale.enum.pt,
          localeSource: LocaleSource.enum.explicit,
          baseCurrency: null,
        },
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
          baseCurrency: null,
          version: 3,
        },
      },
    ]);
  });

  it('preserves an existing base currency override when only locale changes', async () => {
    const deps = makeDeps(storedRow(Locale.enum.pt, LocaleSource.enum.explicit, 5, CurrencyCode.enum.USDC));
    const result = await setLocale(deps, { locale: Locale.enum.en, source: LocaleSource.enum.explicit });
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: SETTINGS_ENTITY_TAG,
        model: {
          id: SETTINGS_SINGLETON_ID,
          locale: Locale.enum.en,
          localeSource: LocaleSource.enum.explicit,
          baseCurrency: CurrencyCode.enum.USDC,
          version: 5,
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

describe('setBaseCurrency', () => {
  it('emits an insert with locale/localeSource defaults when no settings row exists yet', async () => {
    const deps = makeDeps(undefined);
    const result = await setBaseCurrency(deps, { baseCurrency: CurrencyCode.enum.BTC });
    const outcome = result._unsafeUnwrap();
    expect(outcome.response).toEqual({ baseCurrency: CurrencyCode.enum.BTC });
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.insert,
        entity: SETTINGS_ENTITY_TAG,
        model: {
          id: SETTINGS_SINGLETON_ID,
          locale: Locale.enum.en,
          localeSource: LocaleSource.enum.default,
          baseCurrency: CurrencyCode.enum.BTC,
        },
      },
    ]);
  });

  it('emits a version-guarded update, preserving locale/localeSource, when a settings row already exists', async () => {
    const deps = makeDeps(storedRow(Locale.enum.pt, LocaleSource.enum.explicit, 4, null));
    const result = await setBaseCurrency(deps, { baseCurrency: CurrencyCode.enum.USD });
    const outcome = result._unsafeUnwrap();
    expect(outcome.response).toEqual({ baseCurrency: CurrencyCode.enum.USD });
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: SETTINGS_ENTITY_TAG,
        model: {
          id: SETTINGS_SINGLETON_ID,
          locale: Locale.enum.pt,
          localeSource: LocaleSource.enum.explicit,
          baseCurrency: CurrencyCode.enum.USD,
          version: 4,
        },
      },
    ]);
  });

  it('is a no-op when the requested base currency already matches the stored value', async () => {
    const deps = makeDeps(storedRow(Locale.enum.pt, LocaleSource.enum.explicit, 4, CurrencyCode.enum.USDC));
    const result = await setBaseCurrency(deps, { baseCurrency: CurrencyCode.enum.USDC });
    const outcome = result._unsafeUnwrap();
    expect(outcome.response).toEqual({ baseCurrency: CurrencyCode.enum.USDC });
    expect(outcome.persist).toEqual([]);
  });
});
