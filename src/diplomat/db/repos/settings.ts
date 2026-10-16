import { and, eq } from 'drizzle-orm';
import { UserSettingsEntitySchema, type UserSettingsEntity } from '../../../models/locale.js';
import type { Db } from '../driver.js';
import { userSettings } from '../schema.js';
import { VersionConflict, type EntityApplier } from '../effects.js';

export type SettingsRepo = {
  getLocale: () => Promise<UserSettingsEntity | undefined>;
};

export const settingsRepo = (db: Db, userId: string): SettingsRepo => ({
  getLocale: async () => {
    const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
    if (!row) return undefined;
    return UserSettingsEntitySchema.parse({
      locale: row.locale,
      localeSource: row.localeSource,
      baseCurrency: row.baseCurrency,
      version: row.version,
    });
  },
});

/** Keyed by `user_id`. A collision on insert is the concurrent-first-insert race: retry, don't silently no-op. */
export const userSettingsApplier = (userId: string): EntityApplier => ({
  insert: async (tx, model) => {
    const { locale, localeSource, baseCurrency } = model as UserSettingsEntity;
    const result = await tx
      .insert(userSettings)
      .values({ userId, locale, localeSource, baseCurrency })
      .onConflictDoNothing({ target: userSettings.userId });
    if ((result.rowsAffected ?? 0) === 0) throw new VersionConflict();
    return { applied: true };
  },
  update: async (tx, model) => {
    const { locale, localeSource, baseCurrency, version } = model as UserSettingsEntity;
    const result = await tx
      .update(userSettings)
      .set({ locale, localeSource, baseCurrency, version: version + 1 })
      .where(and(eq(userSettings.userId, userId), eq(userSettings.version, version)));
    return { applied: (result.rowsAffected ?? 0) > 0 };
  },
  delete: async () => {
    throw new Error('userSettingsApplier: delete is unsupported — preferences are never removed');
  },
});
