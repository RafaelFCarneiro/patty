import { eq } from 'drizzle-orm';
import { SETTINGS_SINGLETON_ID, SettingsEntitySchema, type SettingsEntity } from '../../../models/locale.js';
import type { Db } from '../driver.js';
import { settings } from '../schema.js';
import { versionedTableApplier, type EntityApplier } from '../effects.js';

export type SettingsRepo = {
  getLocale: () => Promise<SettingsEntity | undefined>;
};

export const settingsRepo = (db: Db): SettingsRepo => ({
  getLocale: async () => {
    const [row] = await db.select().from(settings).where(eq(settings.id, SETTINGS_SINGLETON_ID));
    if (!row) return undefined;
    return SettingsEntitySchema.parse({
      id: row.id,
      locale: row.locale,
      localeSource: row.localeSource,
      version: row.version,
    });
  },
});

// Singleton row, but still id/version-shaped (id is always SETTINGS_SINGLETON_ID).
export const settingsApplier: EntityApplier = versionedTableApplier(settings);
