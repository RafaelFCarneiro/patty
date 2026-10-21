import { eq } from 'drizzle-orm';
import * as instanceSettingsAdapters from '../../../adapters/instance-settings.js';
import { INSTANCE_SETTINGS_ID, type InstanceSettingsEntity } from '../../../models/auth/users.js';
import type { Db } from '../driver.js';
import { settings } from '../schema.js';
import { versionedTableApplier, type EntityApplier } from '../effects.js';

export type InstanceSettingsRepo = {
  /** The singleton row, which a migration guarantees exists. */
  get: () => Promise<InstanceSettingsEntity>;
};

export const instanceSettingsRepo = (db: Db): InstanceSettingsRepo => ({
  get: async () => {
    const [row] = await db.select().from(settings).where(eq(settings.id, INSTANCE_SETTINGS_ID)).limit(1);
    if (!row) throw new Error('instance settings: the singleton row is missing');
    return instanceSettingsAdapters.dbToModel(row);
  },
});

export const instanceSettingsApplier: EntityApplier = versionedTableApplier(settings);
