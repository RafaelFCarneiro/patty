import { eq } from 'drizzle-orm';
import { SETTINGS_SINGLETON_ID, SettingsEntitySchema, type SettingsEntity } from '../../../models/locale.js';
import type { Db } from '../driver.js';
import { settings } from '../schema.js';
import { versionedTableApplier, type EntityApplier } from '../effects.js';

export type SettingsRepo = {
  /** Version-carrying read — for `setLocale`, which needs it to decide between an insert (no
   *  settings row exists yet) and a version-guarded update. */
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

/**
 * The settings entity's `EntityApplier` — `settings` is a singleton table but still follows the
 * `id`/`version` convention (`id` is always `SETTINGS_SINGLETON_ID`), so this is just
 * `versionedTableApplier(settings)`, same as `accountApplier`.
 */
export const settingsApplier: EntityApplier = versionedTableApplier(settings);
