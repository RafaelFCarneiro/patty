import { eq } from 'drizzle-orm';
import { SETTINGS_SINGLETON_ID, SettingsEntitySchema, type SettingsEntity } from '../../../models/locale.js';
import type { Db } from '../driver.js';
import { settings } from '../schema.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

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
      baseCurrency: row.baseCurrency,
      version: row.version,
    });
  },
});

// Singleton row, but still id/version-shaped (id is always SETTINGS_SINGLETON_ID). Unlike a
// random-UUID-keyed entity, an id collision on insert here IS the concurrent-first-insert race
// (two callers both reading "no row yet" and deciding insert), not a negligible chance event — so,
// unlike the plain `versionedTableApplier`, a collision must retry rather than silently no-op:
// the loser's `setLocale` call would otherwise report success without its own value ever landing.
const versionedSettingsApplier = versionedTableApplier(settings);
export const settingsApplier: EntityApplier = {
  ...versionedSettingsApplier,
  insert: async (tx, model) => {
    const outcome = await versionedSettingsApplier.insert(tx, model);
    if (!outcome.applied) throw new VersionConflict();
    return outcome;
  },
};
