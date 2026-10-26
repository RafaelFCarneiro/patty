import { eq } from 'drizzle-orm';
import { INSTANCE_SETTINGS_ID } from '../../../models/auth/users.js';
import { InstanceKind } from '../../../models/instance.js';
import type { Db } from '../driver.js';
import { settings } from '../schema.js';

export type InstanceRepo = {
  /** What this database says it is, read from the singleton row (not from a path or an env var). */
  kind: () => Promise<InstanceKind>;
};

export const instanceRepo = (db: Db): InstanceRepo => ({
  kind: async () => {
    const [row] = await db
      .select({ kind: settings.instanceKind })
      .from(settings)
      .where(eq(settings.id, INSTANCE_SETTINGS_ID))
      .limit(1);
    return InstanceKind.parse(row?.kind);
  },
});
