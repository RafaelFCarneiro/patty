import { eq } from 'drizzle-orm'
import type { Locale, LocaleSource } from '../../../models/locale.js'
import type { Db } from '../driver.js'
import { settings } from '../schema.js'

const SINGLETON_ID = 'singleton'

export type SettingsRepo = {
  getLocale: () => Promise<{ locale: Locale; localeSource: LocaleSource } | undefined>
  setLocale: (locale: Locale, localeSource: LocaleSource) => Promise<void>
}

export const settingsRepo = (db: Db): SettingsRepo => ({
  getLocale: async () => {
    const [row] = await db.select().from(settings).where(eq(settings.id, SINGLETON_ID))
    if (!row) return undefined
    return { locale: row.locale as Locale, localeSource: row.localeSource as LocaleSource }
  },

  setLocale: async (locale, localeSource) => {
    await db
      .insert(settings)
      .values({ id: SINGLETON_ID, locale, localeSource })
      .onConflictDoUpdate({
        target: settings.id,
        set: { locale, localeSource },
      })
  },
})
