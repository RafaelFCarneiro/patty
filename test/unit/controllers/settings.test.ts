import { describe, expect, it } from 'vitest'
import { Locale, LocaleSource } from '../../../src/models/locale.js'
import { getPreferences, setLocale } from '../../../src/controllers/settings.js'
import type { Deps } from '../../../src/controllers/deps.js'

const makeDeps = (stored?: { locale: Locale; localeSource: LocaleSource }, envLocale?: Locale): Deps => ({
  settings: {
    getLocale: async () => stored,
    setLocale: async () => {},
  },
  locale: async () => envLocale ?? stored?.locale ?? Locale.enum.en,
  accounts: {} as Deps['accounts'],
  bills: {} as Deps['bills'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  creditCards: {} as Deps['creditCards'],
  merchants: {} as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  tags: {} as Deps['tags'],
  transactions: {} as Deps['transactions'],
  clock: () => new Date(),
  newId: () => 'test-id',
})

describe('getPreferences', () => {
  it('returns stored locale and source from DB', async () => {
    const deps = makeDeps(
      { locale: Locale.enum.pt, localeSource: LocaleSource.enum.explicit },
      Locale.enum.en,
    )
    const prefs = await getPreferences(deps)
    expect(prefs).toEqual({ locale: Locale.enum.pt, localeSource: LocaleSource.enum.explicit })
  })

  it('returns DB values even when env locale differs', async () => {
    const deps = makeDeps(
      { locale: Locale.enum.pt, localeSource: LocaleSource.enum.inferred },
      Locale.enum.en,
    )
    const prefs = await getPreferences(deps)
    expect(prefs.locale).toBe(Locale.enum.pt)
  })

  it('defaults to en/default when no settings row exists', async () => {
    const deps = makeDeps(undefined)
    const prefs = await getPreferences(deps)
    expect(prefs).toEqual({ locale: Locale.enum.en, localeSource: LocaleSource.enum.default })
  })
})

describe('setLocale', () => {
  it('returns the written locale, not the env-resolved one', async () => {
    const deps = makeDeps(undefined, Locale.enum.en)
    const result = await setLocale(deps, { locale: Locale.enum.pt, source: LocaleSource.enum.explicit })
    expect(result._unsafeUnwrap()).toEqual({ locale: Locale.enum.pt, localeSource: LocaleSource.enum.explicit })
  })

  it('rejects inferred switch when current source is explicit', async () => {
    const deps = makeDeps({ locale: Locale.enum.pt, localeSource: LocaleSource.enum.explicit })
    const result = await setLocale(deps, { locale: Locale.enum.en, source: LocaleSource.enum.inferred })
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'validation' })
  })

  it('allows explicit switch when current source is explicit', async () => {
    const deps = makeDeps({ locale: Locale.enum.pt, localeSource: LocaleSource.enum.explicit })
    const result = await setLocale(deps, { locale: Locale.enum.en, source: LocaleSource.enum.explicit })
    expect(result.isOk()).toBe(true)
  })

  it('inferred no-op preserves explicit source', async () => {
    const deps = makeDeps({ locale: Locale.enum.pt, localeSource: LocaleSource.enum.explicit })
    const result = await setLocale(deps, { locale: Locale.enum.pt, source: LocaleSource.enum.inferred })
    expect(result._unsafeUnwrap()).toEqual({ locale: Locale.enum.pt, localeSource: LocaleSource.enum.explicit })
  })
})
