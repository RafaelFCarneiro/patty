import { eq } from 'drizzle-orm';
import * as instanceSettingsAdapters from '../../../adapters/instanceSettings.js';
import { INSTANCE_SETTINGS_ID, type InstanceSettingsEntity } from '../../../models/auth/users.js';
import type { Db } from '../driver.js';
import { settings } from '../schema.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

export type InstanceSettingsRepo = {
  /** The singleton row, or `null` while nobody has changed an instance setting (the defaults apply). */
  get: () => Promise<InstanceSettingsEntity | null>;
};

export const instanceSettingsRepo = (db: Db): InstanceSettingsRepo => ({
  get: async () => {
    const [row] = await db.select().from(settings).where(eq(settings.id, INSTANCE_SETTINGS_ID)).limit(1);
    return row ? instanceSettingsAdapters.dbToModel(row) : null;
  },
});

const versionedSettingsApplier = versionedTableApplier(settings);

// Singleton row: an id collision on insert IS the concurrent-first-write race (two admins both saw no row). The plain
// applier would silently no-op the loser, who would report a change that never happened — so it retries instead, and
// the retry updates the winner's row.
export const instanceSettingsApplier: EntityApplier = {
  ...versionedSettingsApplier,
  insert: async (tx, model) => {
    const outcome = await versionedSettingsApplier.insert(tx, model);
    if (!outcome.applied) throw new VersionConflict();
    return outcome;
  },
};
